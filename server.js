const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const PROJECTS_FILE = path.join(__dirname, 'data', 'projects.txt');
const startTs = Date.now();

// === Templates ===
const TEMPLATES = [
  {
    id: 'supabase', name: 'Supabase', icon: '⚡',
    fields: [
      { key: 'ref', label: 'Project Ref', placeholder: 'xyzxyz', required: true },
      { key: 'anon_key', label: 'Anon Key', placeholder: 'eyJhbG...', required: true, secret: true }
    ],
    buildUrl: (f) => `https://${f.ref}.supabase.co/rest/v1/`,
    buildHeaders: (f) => ({ 'apikey': f.anon_key, 'Authorization': `Bearer ${f.anon_key}` }),
    method: 'GET'
  },
  {
    id: 'vercel', name: 'Vercel', icon: '▲',
    fields: [
      { key: 'domain', label: 'Domain', placeholder: 'my-app.vercel.app', required: true }
    ],
    buildUrl: (f) => `https://${f.domain}/`,
    buildHeaders: () => ({}),
    method: 'GET'
  },
  {
    id: 'render', name: 'Render', icon: '🟢',
    fields: [
      { key: 'domain', label: 'Domain', placeholder: 'my-app.onrender.com', required: true }
    ],
    buildUrl: (f) => `https://${f.domain}/`,
    buildHeaders: () => ({}),
    method: 'GET'
  },
  {
    id: 'neon', name: 'Neon', icon: '🐘',
    fields: [
      { key: 'host', label: 'Host', placeholder: 'ep-cool-bird-123.us-east-2.aws.neon.tech', required: true },
      { key: 'password', label: 'Password', placeholder: 'npg_...', required: true, secret: true }
    ],
    buildUrl: (f) => `https://${f.host}/sql`,
    buildHeaders: (f) => ({ 'Neon-Connection-String': `postgresql://user:${f.password}@${f.host}/main` }),
    method: 'POST',
    body: '{"query": "SELECT 1"}'
  },
  {
    id: 'railway', name: 'Railway', icon: '🚂',
    fields: [
      { key: 'domain', label: 'Domain', placeholder: 'my-app.up.railway.app', required: true }
    ],
    buildUrl: (f) => `https://${f.domain}/`,
    buildHeaders: () => ({}),
    method: 'GET'
  },
  {
    id: 'cf-workers', name: 'Cloudflare Workers', icon: '☁️',
    fields: [
      { key: 'domain', label: 'Domain', placeholder: 'my-worker.workers.dev', required: true }
    ],
    buildUrl: (f) => `https://${f.domain}/`,
    buildHeaders: () => ({}),
    method: 'GET'
  },
  {
    id: 'generic', name: 'Generic HTTP', icon: '🌐',
    fields: [
      { key: 'url', label: 'URL', placeholder: 'https://example.com/health', required: true }
    ],
    buildUrl: (f) => f.url,
    buildHeaders: () => ({}),
    method: 'GET'
  }
];

function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id);
}

// === Projects ===
let projects = [];

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const content = fs.readFileSync(PROJECTS_FILE, 'utf8');
      if (content.trim()) {
        projects = content.split('\n').filter(l => l.trim()).map(l => {
          const parts = l.split('|');
          // v1 format: name|url|key (3 parts, no template)
          if (parts.length === 3 && !parts[2].includes('=')) {
            const [name, url, key] = parts;
            if (url.includes('supabase.co')) {
              const ref = url.replace('https://', '').replace('.supabase.co', '');
              return { name, template: 'supabase', fields: { ref, anon_key: key } };
            }
            return { name, template: 'generic', fields: { url } };
          }
          // v2 format: name|template|field1=val1;field2=val2
          const [name, template, fieldsStr] = parts;
          const fields = {};
          (fieldsStr || '').split(';').forEach(pair => {
            const [k, ...v] = pair.split('=');
            if (k) fields[k] = v.join('=');
          });
          return { name, template, fields };
        });
        return;
      }
    }
  } catch (e) {}
  projects = [];
  saveProjects();
}

function saveProjects() {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = projects.map(p => {
    const fieldsStr = Object.entries(p.fields).map(([k, v]) => `${k}=${v}`).join(';');
    return `${p.name}|${p.template}|${fieldsStr}`;
  }).join('\n');
  fs.writeFileSync(PROJECTS_FILE, content);
}

function maskSecret(val) {
  if (!val || val.length < 10) return '***';
  return val.slice(0, 3) + '...' + val.slice(-3);
}

function maskProject(p) {
  const tmpl = getTemplate(p.template);
  const maskedFields = { ...p.fields };
  if (tmpl) {
    tmpl.fields.forEach(f => {
      if (f.secret && maskedFields[f.key]) {
        maskedFields[f.key] = maskSecret(maskedFields[f.key]);
      }
    });
  }
  return { name: p.name, template: p.template, fields: maskedFields, lastPing: p.lastPing || null, lastPingTime: p.lastPingTime || null };
}

function validateName(name) {
  return /^[a-z0-9-]{1,50}$/.test(name);
}

// === Ping ===
async function pingProject(project) {
  const tmpl = getTemplate(project.template);
  if (!tmpl) return { name: project.name, ok: false, error: 'unknown template' };

  const url = tmpl.buildUrl(project.fields);
  const headers = tmpl.buildHeaders(project.fields);
  const method = tmpl.method || 'GET';
  const body = tmpl.body || null;

  return new Promise((resolve) => {
    const parsed = new URL(url);
    const start = Date.now();
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : require('http');

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 5000
    };

    const req = lib.request(opts, (res) => {
      const ms = Date.now() - start;
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = { name: project.name, ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, ms };
        project.lastPing = result;
        project.lastPingTime = new Date().toISOString();
        resolve(result);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const result = { name: project.name, ok: false, error: 'timeout', ms: 5000 };
      project.lastPing = result;
      project.lastPingTime = new Date().toISOString();
      resolve(result);
    });

    req.on('error', (e) => {
      const result = { name: project.name, ok: false, error: e.message, ms: Date.now() - start };
      project.lastPing = result;
      project.lastPingTime = new Date().toISOString();
      resolve(result);
    });

    if (body) req.write(body);
    req.end();
  });
}

let lastPingTime = null;

async function pingAll() {
  const results = await Promise.all(projects.map(p => pingProject(p)));
  lastPingTime = new Date().toISOString();
  console.log(`[${lastPingTime}] Ping all: ${results.filter(r => r.ok).length}/${results.length} alive`);
  saveProjects();
  return results;
}

// === Auth ===
function checkAuth(req) {
  if (!AUTH_TOKEN) return true; // no auth configured
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${AUTH_TOKEN}`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve(null); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// === Boot ===
loadProjects();
if (projects.length > 0) pingAll();
setInterval(pingAll, 12 * 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Serve index.html
  if (url.pathname === '/' && req.method === 'GET') {
    try {
      const content = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch { res.writeHead(500); res.end('Error'); }
    return;
  }

  // Health (no auth)
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, uptime: Math.floor((Date.now() - startTs) / 1000), projects: projects.length, lastPing: lastPingTime });
  }

  // Templates (no auth)
  if (url.pathname === '/api/templates' && req.method === 'GET') {
    return json(res, 200, TEMPLATES.map(t => ({ id: t.id, name: t.name, icon: t.icon, fields: t.fields })));
  }

  // Auth check for everything below
  if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });

  // List projects
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    return json(res, 200, projects.map(maskProject));
  }

  // Add project
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: 'Invalid JSON' });

    const { name, template, fields } = body;
    if (!validateName(name)) return json(res, 400, { error: 'Invalid name (lowercase alphanumeric + hyphens, max 50)' });
    if (!getTemplate(template)) return json(res, 400, { error: 'Unknown template' });
    if (projects.some(p => p.name === name)) return json(res, 409, { error: 'Project name exists' });

    // Validate required fields
    const tmpl = getTemplate(template);
    for (const f of tmpl.fields) {
      if (f.required && (!fields || !fields[f.key])) return json(res, 400, { error: `Missing field: ${f.label}` });
    }

    projects.push({ name, template, fields: fields || {} });
    saveProjects();
    return json(res, 201, { success: true });
  }

  // Update project
  const updateMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (updateMatch && req.method === 'PUT') {
    const idx = projects.findIndex(p => p.name === updateMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'Not found' });

    const body = await parseBody(req);
    if (!body) return json(res, 400, { error: 'Invalid JSON' });

    if (body.fields) projects[idx].fields = { ...projects[idx].fields, ...body.fields };
    saveProjects();
    return json(res, 200, { success: true });
  }

  // Delete project
  const deleteMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const idx = projects.findIndex(p => p.name === deleteMatch[1]);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    projects.splice(idx, 1);
    saveProjects();
    return json(res, 200, { success: true });
  }

  // Ping single
  const pingMatch = url.pathname.match(/^\/api\/ping\/([a-z0-9-]+)$/);
  if (pingMatch && req.method === 'GET') {
    const project = projects.find(p => p.name === pingMatch[1]);
    if (!project) return json(res, 404, { error: 'Not found' });
    const result = await pingProject(project);
    saveProjects();
    return json(res, 200, result);
  }

  // Ping all
  if (url.pathname === '/api/ping-all' && req.method === 'GET') {
    const results = await pingAll();
    return json(res, 200, results);
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Keep-alive server running on port ${PORT}${AUTH_TOKEN ? ' (auth enabled)' : ' (no auth)'}`);
});
