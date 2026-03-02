const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const PORT = 9999;
const SESSIONS_JSON = path.join(process.env.HOME, '.openclaw/agents/main/sessions/sessions.json');

function extractTask(sessionFile) {
  try {
    if (!sessionFile || !fs.existsSync(sessionFile)) return '';
    const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').slice(0, 20);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message' && obj.message?.role === 'user') {
          const text = Array.isArray(obj.message.content)
            ? obj.message.content.map(c => c.text || '').join('')
            : (obj.message.content || '');
          const match = text.match(/\[Subagent Task\]:\s*([\s\S]*)/);
          if (match) return match[1].trim();
          return text.trim();
        }
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

function getSessionData() {
  try {
    const raw = fs.readFileSync(SESSIONS_JSON, 'utf-8');
    const sessionsMap = JSON.parse(raw);
    const now = Date.now();
    const activeWindow = 1440 * 60 * 1000; // 24h

    return Object.entries(sessionsMap)
      .filter(([_, s]) => (now - s.updatedAt) < activeWindow)
      .map(([key, s]) => {
        const isSubagent = key.includes('subagent:');
        const label = s.label || (isSubagent
          ? 'Subagent ' + key.split(':').pop().slice(0, 8)
          : key.split(':').pop());
        const ageMs = now - s.updatedAt;
        const status = ageMs < 60000 ? 'running' : ageMs < 300000 ? 'completed' : 'idle';
        const task = extractTask(s.sessionFile);
        return {
          id: key,
          label,
          task,
          model: s.model || 'unknown',
          provider: s.modelProvider || '',
          status,
          totalTokens: s.totalTokens || 0,
          inputTokens: s.inputTokens || 0,
          outputTokens: s.outputTokens || 0,
          contextTokens: s.contextTokens || 200000,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt || s.updatedAt - (s.totalTokens ? 120000 : 60000),
          startedAt: s.createdAt || s.updatedAt - (s.totalTokens ? 120000 : 60000),
          ageMs,
          kind: s.chatType || 'direct',
          isSubagent,
          agentId: 'main',
          sessionKey: key
        };
      });
  } catch (e) {
    return [];
  }
}

function getAllSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_JSON, 'utf-8');
    const sessionsMap = JSON.parse(raw);
    const now = Date.now();

    return Object.entries(sessionsMap)
      .map(([key, s]) => {
        const isSubagent = key.includes('subagent:');
        const label = s.label || (isSubagent
          ? 'Subagent ' + key.split(':').pop().slice(0, 8)
          : key.split(':').pop());
        const ageMs = now - s.updatedAt;
        const status = ageMs < 60000 ? 'running' : ageMs < 300000 ? 'completed' : 'idle';
        const task = extractTask(s.sessionFile);
        return {
          id: key, label, task, model: s.model || 'unknown', provider: s.modelProvider || '',
          status, totalTokens: s.totalTokens || 0, inputTokens: s.inputTokens || 0,
          outputTokens: s.outputTokens || 0, updatedAt: s.updatedAt,
          createdAt: s.createdAt || s.updatedAt, ageMs, isSubagent, sessionKey: key
        };
      });
  } catch (e) {
    return [];
  }
}

function getCostData() {
  try {
    const raw = execSync('openclaw gateway usage-cost --json --days 1 2>/dev/null', {
      timeout: 10000, encoding: 'utf-8'
    });
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sessions = getSessionData();
    const cost = getCostData();
    res.end(JSON.stringify({ sessions, cost, timestamp: Date.now() }));

  } else if (req.url === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sessions = getAllSessions();
    res.end(JSON.stringify({ sessions, timestamp: Date.now() }));

  } else if (req.url === '/api/kill' && req.method === 'POST') {
    try {
      const { sessionKey } = await parseBody(req);
      exec(`openclaw subagents kill "${sessionKey}" 2>&1`, { timeout: 15000 }, (err, stdout, stderr) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !err, message: stdout || stderr || 'sent kill signal' }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (req.url === '/api/rerun' && req.method === 'POST') {
    try {
      const { task, label } = await parseBody(req);
      const safeLabel = (label || 'rerun').replace(/[^a-zA-Z0-9_-]/g, '-');
      const safeTask = task.replace(/'/g, "'\\''");
      exec(`openclaw run --label '${safeLabel}' '${safeTask}' 2>&1 &`, { timeout: 5000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Spawned re-run' }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (req.url === '/api/launch' && req.method === 'POST') {
    try {
      const { task, label } = await parseBody(req);
      const safeLabel = (label || 'launched').replace(/[^a-zA-Z0-9_-]/g, '-');
      const safeTask = task.replace(/'/g, "'\\''");
      exec(`openclaw run --label '${safeLabel}' '${safeTask}' 2>&1 &`, { timeout: 5000 }, (err, stdout) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Launched bot' }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
  } else if (req.url === '/status.json') {
    const p = path.join(__dirname, 'status.json');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(p, 'utf-8'));
    } else { res.writeHead(404); res.end('Not found'); }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

function writeStatusJson() {
  try {
    const sessions = getSessionData();
    const cost = getCostData();
    const allSessions = getAllSessions();
    const json = JSON.stringify({ sessions, cost, history: allSessions, timestamp: Date.now() });
    fs.writeFileSync(path.join(__dirname, 'status.json'), json);
    const deployDir = path.join(__dirname, 'deploy');
    if (fs.existsSync(deployDir)) {
      fs.writeFileSync(path.join(deployDir, 'status.json'), json);
    }
  } catch (e) {
    console.error('Failed to write status.json:', e.message);
  }
}
writeStatusJson();
setInterval(writeStatusJson, 5000);

server.listen(PORT, () => {
  console.log(`🦞 Bot Command Center running at http://localhost:${PORT}`);
});
