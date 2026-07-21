const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const PING_INTERVAL_HOURS = parseInt(process.env.PING_INTERVAL_HOURS || '12', 10);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const LEGACY_FILE = path.join(DATA_DIR, 'projects.txt');
const MAX_HISTORY = 20;
const startTs = Date.now();

// === R2 Storage ===
let S3Client, PutObjectCommand, GetObjectCommand;
let r2Client = null;
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || '';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_ENABLED = !!(R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET);

if (R2_ENABLED) {
  try {
    const s3 = require('@aws-sdk/client-s3');
    S3Client = s3.S3Client;
    PutObjectCommand = s3.PutObjectCommand;
    GetObjectCommand = s3.GetObjectCommand;
    r2Client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
    });
    console.log('R2 storage enabled');
  } catch (e) {
    console.error(`R2 init failed: ${e.message}`);
  }
}

async function r2Get(key) {
  if (!r2Client) return null;
  try {
    const res = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return await res.Body.transformToString();
  } catch { return null; }
}

async function r2Put(key, body) {
  if (!r2Client) return;
  await r2Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
}

// === Write Mutex ===
let writing = false;
const writeQueue = [];

function enqueueWrite(key, data) {
  writeQueue.push({ key, data });
  if (writing) return;
  writing = true;
  (async () => {
    try {
      while (writeQueue.length) {
        const item = writeQueue.shift();
        const localPath = item.key === 'db.json' ? DB_FILE : HISTORY_FILE;
        try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); } catch {}
        try { fs.writeFileSync(localPath, item.data); } catch (e) { console.error(`Local write ${item.key} failed: ${e.message}`); }
        try { await r2Put(item.key, item.data); }
        catch (e) { console.error(`R2 write ${item.key} failed: ${e.message}`); }
      }
    } finally { writing = false; }
  })();
}

// === Templates ===
const TEMPLATES = [
  {
    id: 'supabase', name: 'Supabase', icon: '⚡',
    fields: [
      { key: 'ref', label: 'Project Ref', placeholder: 'xyzxyz', required: true },
      { key: 'anon_key', label: 'Anon Key', placeholder: 'eyJhbG...', required: true, secret: true }
    ],
    buildUrl: (f) => `https://${f.ref}.supabase.co/auth/v1/health`,
    buildHeaders: (f) => ({ 'apikey': f.anon_key, 'Authorization': `Bearer ${f.anon_key}` }),
    method: 'GET'
  },
  {
    id: 'vercel', name: 'Vercel', icon: '▲',
    fields: [{ key: 'domain', label: 'Domain', placeholder: 'my-app.vercel.app', required: true }],
    buildUrl: (f) => `https://${f.domain}/`, buildHeaders: () => ({}), method: 'GET'
  },
  {
    id: 'render', name: 'Render', icon: '🟢',
    fields: [{ key: 'domain', label: 'Domain', placeholder: 'my-app.onrender.com', required: true }],
    buildUrl: (f) => `https://${f.domain}/`, buildHeaders: () => ({}), method: 'GET'
  },
  {
    id: 'neon', name: 'Neon', icon: '🐘',
    fields: [
      { key: 'host', label: 'Host', placeholder: 'ep-cool-bird-123.us-east-2.aws.neon.tech', required: true },
      { key: 'password', label: 'Password', placeholder: 'npg_...', required: true, secret: true }
    ],
    buildUrl: (f) => `https://${f.host}/sql`,
    buildHeaders: (f) => ({ 'Neon-Connection-String': `postgresql://user:${f.password}@${f.host}/main` }),
    method: 'POST', body: '{"query": "SELECT 1"}'
  },
  {
    id: 'railway', name: 'Railway', icon: '🚂',
    fields: [{ key: 'domain', label: 'Domain', placeholder: 'my-app.up.railway.app', required: true }],
    buildUrl: (f) => `https://${f.domain}/`, buildHeaders: () => ({}), method: 'GET'
  },
  {
    id: 'cf-workers', name: 'Cloudflare Workers', icon: '☁️',
    fields: [{ key: 'domain', label: 'Domain', placeholder: 'my-worker.workers.dev', required: true }],
    buildUrl: (f) => `https://${f.domain}/`, buildHeaders: () => ({}), method: 'GET'
  },
  {
    id: 'generic', name: 'Generic HTTP', icon: '🌐',
    fields: [{ key: 'url', label: 'URL', placeholder: 'https://example.com/health', required: true }],
    buildUrl: (f) => {
      const url = new URL(f.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
      // ponytail: no DNS check, add if SSRF matters beyond personal use
      return f.url;
    }, buildHeaders: () => ({}), method: 'GET'
  }
];

function getTemplate(id) { return TEMPLATES.find(t => t.id === id); }

// === State ===
let db = { version: 2, config: { pingIntervalHours: PING_INTERVAL_HOURS }, projects: [] };
let history = {};

function parseLegacyProjects(content) {
  return content.split('\n').filter(l => l.trim()).map(l => {
    const firstPipe = l.indexOf('|');
    const secondPipe = l.indexOf('|', firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) return null;
    const name = l.substring(0, firstPipe);
    const template = l.substring(firstPipe + 1, secondPipe);
    const fieldsStr = l.substring(secondPipe + 1);
    if (!fieldsStr.includes('=')) {
      if (template.includes('supabase.co')) {
        const ref = template.replace('https://', '').replace('.supabase.co', '');
        return { name, template: 'supabase', fields: { ref, anon_key: fieldsStr } };
      }
      return { name, template: 'generic', fields: { url: template } };
    }
    const fields = {};
    fieldsStr.split(';').forEach(pair => { const eq = pair.indexOf('='); if (eq > 0) fields[pair.substring(0, eq)] = pair.substring(eq + 1); });
    return { name, template, fields };
  }).filter(Boolean);
}

function saveDb() { enqueueWrite('db.json', JSON.stringify(db, null, 2)); }
function saveHistory() { enqueueWrite('history.json', JSON.stringify(history)); }

// Boot sequence
async function boot() {
  // 1. Try local db.json
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      console.log(`Loaded ${db.projects.length} projects from local db.json`);
      loadHistoryLocal();
      return;
    }
  } catch (e) { console.error(`db.json parse error: ${e.message}`); }

  // 2. Try legacy projects.txt (migration)
  try {
    if (fs.existsSync(LEGACY_FILE)) {
      const content = fs.readFileSync(LEGACY_FILE, 'utf8');
      if (content.trim()) {
        db.projects = parseLegacyProjects(content);
        console.log(`Migrated ${db.projects.length} projects from projects.txt`);
        saveDb();
        try { fs.unlinkSync(LEGACY_FILE); } catch {}
        loadHistoryLocal();
        return;
      }
    }
  } catch {}

  // 3. Try R2 (await before serving)
  try {
    const dbData = await r2Get('db.json');
    if (dbData) { db = JSON.parse(dbData); saveDb(); console.log(`Restored ${db.projects.length} projects from R2`); }
  } catch {}
  try {
    const histData = await r2Get('history.json');
    if (histData) { history = JSON.parse(histData); saveHistory(); console.log('Restored history from R2'); }
  } catch {}

  loadHistoryLocal();
}

function loadHistoryLocal() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch {}
}

boot().then(() => {
  if (db.projects.length > 0) pingAll();
  setInterval(pingAll, db.config.pingIntervalHours * 60 * 60 * 1000);
});

// === Ping ===
async function doPing(project) {
  const tmpl = getTemplate(project.template);
  if (!tmpl) return { name: project.name, ok: false, error: 'unknown template' };
  let url, headers, method, body;
  try {
    url = tmpl.buildUrl(project.fields);
    headers = tmpl.buildHeaders(project.fields);
    method = tmpl.method || 'GET';
    body = tmpl.body || null;
  } catch (e) { return { name: project.name, ok: false, error: e.message, ms: 0 }; }
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ name: project.name, ok: false, error: 'invalid URL', ms: 0 }); return; }
    const start = Date.now();
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : require('http');
    const opts = { hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80), path: parsed.pathname + parsed.search, method, headers, timeout: 5000 };
    const req = lib.request(opts, (res) => {
      const ms = Date.now() - start;
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ name: project.name, ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ms }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ name: project.name, ok: false, error: 'timeout', ms: 5000 }); });
    req.on('error', (e) => resolve({ name: project.name, ok: false, error: e.message, ms: Date.now() - start }));
    if (body) req.write(body);
    req.end();
  });
}

async function pingProject(project) {
  const result = await doPing(project);
  if (!history[project.name]) history[project.name] = [];
  history[project.name].push({ ok: result.ok, status: result.status, ms: result.ms, time: new Date().toISOString(), error: result.error });
  if (history[project.name].length > MAX_HISTORY) history[project.name] = history[project.name].slice(-MAX_HISTORY);
  return result;
}

let lastPingTime = null;
async function pingAll() {
  const results = await Promise.all(db.projects.map(p => pingProject(p)));
  lastPingTime = new Date().toISOString();
  console.log(`[${lastPingTime}] Ping: ${results.filter(r => r.ok).length}/${results.length} alive`);
  saveDb();
  saveHistory();
  return results;
}

// === Auth ===
function checkAuth(req, url) {
  if (!AUTH_TOKEN) return true;
  if ((req.headers['authorization'] || '') === `Bearer ${AUTH_TOKEN}`) return true;
  if (url && url.searchParams.get('token') === AUTH_TOKEN) return true;
  return false;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function validateName(name) {
  if (!name || name.trim().length === 0 || name.length > 255) return false;
  if (/[\n\r\0|]/.test(name)) return false;
  return true;
}

function maskSecret(val) {
  if (!val || val.length < 10) return '***';
  return val.slice(0, 3) + '...' + val.slice(-3);
}

function maskProject(p) {
  const tmpl = getTemplate(p.template);
  const maskedFields = { ...p.fields };
  if (tmpl) tmpl.fields.forEach(f => { if (f.secret && maskedFields[f.key]) maskedFields[f.key] = maskSecret(maskedFields[f.key]); });
  const h = history[p.name] || [];
  const lastPing = h.length > 0 ? h[h.length - 1] : null;
  return { name: p.name, template: p.template, fields: maskedFields, lastPing, lastPingTime: lastPing?.time || null, pingHistory: h };
}

function matchRoute(pattern, pathname) {
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$');
  const m = pathname.match(regex);
  return m ? m.slice(1) : null;
}

// === Server ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/' && req.method === 'GET') {
    try { const c = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(c); }
    catch { res.writeHead(500); res.end('Error'); }
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    if (!checkAuth(req, url)) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - startTs) / 1000), projects: db.projects.length, lastPing: lastPingTime, pingIntervalHours: db.config.pingIntervalHours, r2Enabled: R2_ENABLED });
  }

  // R2 diagnostic
  if (pathname === '/api/r2-test' && req.method === 'GET') {
    if (!checkAuth(req, url)) return json(res, 401, { error: 'Unauthorized' });
    if (!r2Client) return json(res, 200, { r2Enabled: false, error: 'R2 not configured' });
    try {
      await r2Put('__test.txt', 'ping ' + Date.now());
      const read = await r2Get('__test.txt');
      return json(res, 200, { r2Enabled: true, write: true, read: read ? read.substring(0, 30) : null, bucket: R2_BUCKET, endpoint: R2_ENDPOINT });
    } catch (e) {
      return json(res, 200, { r2Enabled: true, write: false, error: e.message, bucket: R2_BUCKET, endpoint: R2_ENDPOINT });
    }
  }

  if (pathname === '/api/templates' && req.method === 'GET') {
    if (!checkAuth(req, url)) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, TEMPLATES.map(t => ({ id: t.id, name: t.name, icon: t.icon, fields: t.fields })));
  }

  if (!checkAuth(req, url)) return json(res, 401, { error: 'Unauthorized' });

  if (pathname === '/api/projects' && req.method === 'GET') {
    return json(res, 200, db.projects.map(maskProject));
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: 'Invalid JSON' });
    const { name, template, fields } = body;
    if (!validateName(name)) return json(res, 400, { error: 'Invalid name' });
    if (!getTemplate(template)) return json(res, 400, { error: 'Unknown template' });
    if (db.projects.some(p => p.name === name)) return json(res, 409, { error: 'Name exists' });
    const tmpl = getTemplate(template);
    for (const f of tmpl.fields) { if (f.required && (!fields || !fields[f.key])) return json(res, 400, { error: `Missing: ${f.label}` }); }
    db.projects.push({ name, template, fields: fields || {} });
    saveDb();
    return json(res, 201, { success: true });
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: 'Invalid JSON' });
    const { template, fields } = body;
    if (!getTemplate(template)) return json(res, 400, { error: 'Unknown template' });
    const tmpl = getTemplate(template);
    for (const f of tmpl.fields) { if (f.required && (!fields || !fields[f.key])) return json(res, 400, { error: `Missing: ${f.label}` }); }
    const result = await doPing({ template, fields });
    return json(res, 200, result);
  }

  let m = matchRoute('/api/projects/:name', pathname);
  if (m && req.method === 'PUT') {
    const name = decodeURIComponent(m[0]);
    const idx = db.projects.findIndex(p => p.name === name);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: 'Invalid JSON' });
    if (body.fields) db.projects[idx].fields = { ...db.projects[idx].fields, ...body.fields };
    saveDb();
    return json(res, 200, { success: true });
  }

  if (m && req.method === 'DELETE') {
    const name = decodeURIComponent(m[0]);
    const idx = db.projects.findIndex(p => p.name === name);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    db.projects.splice(idx, 1);
    delete history[name];
    saveDb();
    saveHistory();
    return json(res, 200, { success: true });
  }

  m = matchRoute('/api/ping/:name', pathname);
  if (m && req.method === 'GET') {
    const name = decodeURIComponent(m[0]);
    const project = db.projects.find(p => p.name === name);
    if (!project) return json(res, 404, { error: 'Not found' });
    const result = await pingProject(project);
    saveDb();
    saveHistory();
    return json(res, 200, result);
  }

  if (pathname === '/api/ping-all' && req.method === 'GET') {
    const results = await pingAll();
    return json(res, 200, results);
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Keep-alive v2.2 on port ${PORT} | interval: ${db.config.pingIntervalHours}h | R2: ${R2_ENABLED ? 'on' : 'off'} | auth: ${AUTH_TOKEN ? 'on' : 'off'}`);
});
