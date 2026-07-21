const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const PROJECTS_FILE = path.join(__dirname, 'data', 'projects.txt');
const startTs = Date.now();

let projects = [];

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const content = fs.readFileSync(PROJECTS_FILE, 'utf8');
      if (content.trim()) {
        projects = content.split('\n').filter(l => l.trim()).map(l => {
          const [name, url, key] = l.split('|');
          return { name, url, key };
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
  const content = projects.map(p => `${p.name}|${p.url}|${p.key}`).join('\n');
  fs.writeFileSync(PROJECTS_FILE, content);
}

function maskKey(key) {
  if (!key || key.length < 10) return '***';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

function validateName(name) {
  return /^[a-z0-9-]{1,50}$/.test(name);
}

async function pingProject(project) {
  return new Promise((resolve) => {
    const url = new URL(project.url);
    const start = Date.now();
    
    const req = https.get({
      hostname: url.hostname,
      path: '/rest/v1/',
      headers: {
        'apikey': project.key,
        'Authorization': `Bearer ${project.key}`
      },
      timeout: 5000
    }, (res) => {
      const ms = Date.now() - start;
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          name: project.name,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          ms
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ name: project.name, ok: false, error: 'timeout', ms: 5000 });
    });

    req.on('error', (e) => {
      resolve({ name: project.name, ok: false, error: e.message, ms: Date.now() - start });
    });
  });
}

let lastPingResults = [];
let lastPingTime = null;

async function pingAll() {
  const results = await Promise.all(projects.map(p => pingProject(p)));
  lastPingResults = results;
  lastPingTime = new Date().toISOString();
  console.log(`[${lastPingTime}] Ping all: ${results.filter(r => r.ok).length}/${results.length} alive`);
  return results;
}

// Boot
loadProjects();
if (projects.length > 0) {
  pingAll();
}
setInterval(pingAll, 12 * 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Serve index.html
  if (url.pathname === '/' && req.method === 'GET') {
    try {
      const content = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading UI');
    }
    return;
  }

  // Health check
  if (url.pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.floor((Date.now() - startTs) / 1000),
      projects: projects.length,
      lastPing: lastPingTime
    }));
    return;
  }

  // List projects
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projects.map(p => ({
      ...p,
      key: maskKey(p.key)
    }))));
    return;
  }

  // Add project
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, url: pUrl, key } = JSON.parse(body);
        
        if (!validateName(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid name (lowercase alphanumeric + hyphens, max 50)' }));
          return;
        }
        if (!pUrl || !pUrl.startsWith('https://')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'URL must start with https://' }));
          return;
        }
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Key required' }));
          return;
        }
        if (projects.some(p => p.name === name)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project name exists' }));
          return;
        }

        projects.push({ name, url: pUrl, key });
        saveProjects();
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Update project
  const updateMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (updateMatch && req.method === 'PUT') {
    const name = updateMatch[1];
    const idx = projects.findIndex(p => p.name === name);
    
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { url: pUrl, key } = JSON.parse(body);
        if (pUrl) {
          if (!pUrl.startsWith('https://')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'URL must start with https://' }));
            return;
          }
          projects[idx].url = pUrl;
        }
        if (key) projects[idx].key = key;
        
        saveProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Delete project
  const deleteMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const name = deleteMatch[1];
    const idx = projects.findIndex(p => p.name === name);
    
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    projects.splice(idx, 1);
    saveProjects();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Ping single
  const pingMatch = url.pathname.match(/^\/api\/ping\/([a-z0-9-]+)$/);
  if (pingMatch && req.method === 'GET') {
    const name = pingMatch[1];
    const project = projects.find(p => p.name === name);
    
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const result = await pingProject(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Ping all
  if (url.pathname === '/api/ping-all' && req.method === 'GET') {
    const results = await pingAll();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Keep-alive server running on port ${PORT}`);
});
