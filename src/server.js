import { readFileSync, watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import {
  PORT, activePlanPath,
  openPlan, updatePlan, archivePlan, restorePlan,
  upsertSession, takeFeedback, queuePrompts, recordLayoutWarnings,
  addAgentReply, endSession, findByKey,
} from './store.js';

const BROWSER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser');
const IDLE_MS = parseInt(process.env.PLANNER_IDLE_MS ?? '') || 30 * 60_000;

const events = new EventEmitter();
events.setMaxListeners(0);

const activePolls = new Map();
const deliveredFeedback = new Set();
const sseClients = new Map();
const fileWatchers = new Map();

let idleTimer = null;

function refreshIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const hasClients = [...sseClients.values()].some(s => s.size > 0);
  if (hasClients || activePolls.size > 0) return;
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
  idleTimer?.unref?.();
}

function computePresence(key) {
  if ((activePolls.get(key) ?? 0) > 0) return 'listening';
  if (deliveredFeedback.has(key)) return 'working';
  return 'waiting';
}

function setActivePolls(key, delta) {
  const prev = computePresence(key);
  const next = (activePolls.get(key) ?? 0) + delta;
  if (next <= 0) activePolls.delete(key); else activePolls.set(key, next);
  const after = computePresence(key);
  if (prev !== after) broadcastSse(key, 'agent-presence', { state: after });
  refreshIdleTimer();
}

function markDelivered(key) {
  deliveredFeedback.add(key);
  broadcastSse(key, 'agent-presence', { state: 'working' });
}

function clearDelivered(key) {
  deliveredFeedback.delete(key);
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSse(key, event, data) {
  for (const res of sseClients.get(key) ?? []) sseEvent(res, event, data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isValidName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 64;
}

function watchPlan(name) {
  if (fileWatchers.has(name)) return;
  try {
    const w = watch(activePlanPath(name), { persistent: false }, () => {
      broadcastSse(name, 'reload', {});
    });
    fileWatchers.set(name, w);
  } catch { /* file may not exist yet */ }
}

function stopWatching(name) {
  fileWatchers.get(name)?.close();
  fileWatchers.delete(name);
}

const BROWSER_FILES = {
  'chrome.js': 'text/javascript',
  'chrome.css': 'text/css',
  'sdk.js': 'text/javascript',
};

function createChromeHtml(session) {
  const sessionData = JSON.stringify({
    key: session.key,
    name: session.name,
    file: session.file,
    initialChat: session.chat ?? [],
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Planner — ${session.name}</title>
  <link rel="stylesheet" href="/browser/chrome.css">
</head>
<body>
  <div class="bar">
    <span class="brand">Planner</span>
    <span class="filename">${session.name}</span>
    <label class="annotate-toggle">
      <input type="checkbox" id="annotateToggle"> Annotate
    </label>
  </div>
  <div class="layout">
    <div class="frame">
      <iframe id="planFrame"
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        data-plan-src="/plan/${encodeURIComponent(session.key)}/index.html"
        title="Plan preview"></iframe>
      <div class="layout-gate" id="layoutGate">
        <div class="layout-gate-box">
          <p id="layoutGateMsg">Checking layout…</p>
          <button id="layoutGateBypass" hidden>Show anyway</button>
        </div>
      </div>
    </div>
    <aside class="panel">
      <div class="chat" id="chatLog"></div>
      <div class="composer">
        <div class="presence-banner" id="presenceBanner" hidden>Agent is not listening yet</div>
        <div class="annotation-pills" id="annotationPills"></div>
        <textarea id="chatInput" placeholder="Write a message or annotate elements above…" rows="3"></textarea>
        <div class="send-row">
          <button id="sendBtn" disabled>Send to Agent</button>
          <button id="endBtn">End Session</button>
        </div>
      </div>
    </aside>
  </div>
  <div class="ended-overlay" id="endedOverlay" hidden>
    <div class="ended-box">
      <h2>Session ended</h2>
      <p>Plan archived.</p>
    </div>
  </div>
  <script id="planner-session" type="application/json">${sessionData}</script>
  <script src="/browser/chrome.js"></script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    if (method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, app: 'planner' });
    }

    if (method === 'POST' && pathname === '/shutdown') {
      send(res, 200, { ok: true });
      setImmediate(() => process.exit(0));
      return;
    }

    // ── Plan lifecycle ────────────────────────────────────────────────────────

    if (method === 'POST' && pathname === '/api/plans/open') {
      const body = await readBody(req);
      const { name, path: sourcePath } = body;
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name. Use letters, numbers, hyphens, underscores only.' });
      if (!sourcePath) return send(res, 400, { error: 'path is required' });
      try {
        openPlan(name, sourcePath);
      } catch (err) {
        return send(res, 409, { error: err.message });
      }
      const session = upsertSession(name);
      watchPlan(name);
      return send(res, 200, { key: session.key, name, url: session.url });
    }

    if (method === 'POST' && pathname === '/api/plans/update') {
      const body = await readBody(req);
      const { name, path: sourcePath } = body;
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name' });
      if (!sourcePath) return send(res, 400, { error: 'path is required' });
      try {
        updatePlan(name, sourcePath);
      } catch (err) {
        return send(res, 404, { error: err.message });
      }
      broadcastSse(name, 'reload', {});
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/plans/archive') {
      const body = await readBody(req);
      const { name } = body;
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name' });
      try {
        archivePlan(name);
      } catch (err) {
        return send(res, 404, { error: err.message });
      }
      stopWatching(name);
      endSession(name);
      events.emit(`ended:${name}`);
      broadcastSse(name, 'agent-presence', { state: 'waiting' });
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/plans/reopen') {
      const body = await readBody(req);
      const { name } = body;
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name' });
      const planFile = activePlanPath(name);
      const { existsSync } = await import('node:fs');
      if (!existsSync(planFile)) return send(res, 404, { error: `Plan "${name}" not found in active plans` });
      const session = upsertSession(name);
      watchPlan(name);
      return send(res, 200, { key: session.key, name, url: session.url });
    }

    if (method === 'POST' && pathname === '/api/plans/restore') {
      const body = await readBody(req);
      const { name } = body;
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name' });
      try {
        restorePlan(name);
      } catch (err) {
        return send(res, err.message.includes('already exists') ? 409 : 404, { error: err.message });
      }
      const session = upsertSession(name);
      watchPlan(name);
      return send(res, 200, { key: session.key, name, url: session.url });
    }

    // ── Poll ──────────────────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/poll') {
      const name = url.searchParams.get('name');
      if (!isValidName(name)) return send(res, 400, { error: 'Invalid plan name' });

      const immediate = takeFeedback(name);
      if (immediate.status !== 'waiting') {
        if (immediate.status === 'feedback') markDelivered(name);
        return send(res, 200, immediate);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(' ');
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 15_000);
      heartbeat.unref?.();
      setActivePolls(name, +1);

      let done = false;
      const cleanup = () => {
        if (done) return; done = true;
        clearInterval(heartbeat);
        clearDelivered(name);
        setActivePolls(name, -1);
        events.off(`feedback:${name}`, respond);
        events.off(`ended:${name}`, respond);
      };
      const respond = () => {
        if (done || res.writableEnded) return;
        const result = takeFeedback(name);
        if (result.status === 'feedback') markDelivered(name);
        res.end(JSON.stringify(result));
        cleanup();
      };
      events.once(`feedback:${name}`, respond);
      events.once(`ended:${name}`, respond);
      req.on('close', cleanup);
      return;
    }

    // ── Browser → server ──────────────────────────────────────────────────────

    const promptsMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/prompts$/);
    if (promptsMatch) {
      const key = promptsMatch[1];
      const body = await readBody(req);
      queuePrompts(key, body.prompts ?? [], body.dom_snapshot ?? '');
      events.emit(`feedback:${key}`);
      return send(res, 200, { ok: true });
    }

    const warningsMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/layout-warnings$/);
    if (warningsMatch) {
      const key = warningsMatch[1];
      const body = await readBody(req);
      const changed = recordLayoutWarnings(key, body.layout_warnings ?? []);
      if (changed) events.emit(`feedback:${key}`);
      return send(res, 200, { ok: true });
    }

    const replyMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/agent-reply$/);
    if (replyMatch) {
      const key = replyMatch[1];
      const body = await readBody(req);
      addAgentReply(key, body.text ?? '');
      broadcastSse(key, 'agent-reply', { text: body.text });
      return send(res, 200, { ok: true });
    }

    // ── SSE ───────────────────────────────────────────────────────────────────

    const sseMatch = method === 'GET' && pathname.match(/^\/events\/([^/]+)$/);
    if (sseMatch) {
      const key = decodeURIComponent(sseMatch[1]);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.flushHeaders?.();

      if (!sseClients.has(key)) sseClients.set(key, new Set());
      sseClients.get(key).add(res);
      refreshIdleTimer();

      const session = findByKey(key);
      sseEvent(res, 'chat-sync', { chat: session?.chat ?? [] });
      sseEvent(res, 'agent-presence', { state: computePresence(key) });

      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
      keepalive.unref?.();

      req.on('close', () => {
        clearInterval(keepalive);
        sseClients.get(key)?.delete(res);
        refreshIdleTimer();
      });
      return;
    }

    // ── Static browser files ──────────────────────────────────────────────────

    const browserMatch = method === 'GET' && pathname.match(/^\/browser\/([^/]+)$/);
    if (browserMatch) {
      const filename = browserMatch[1];
      const mime = BROWSER_FILES[filename];
      if (!mime) { res.writeHead(403); res.end('Forbidden'); return; }
      try {
        const content = readFileSync(path.join(BROWSER_DIR, filename));
        res.writeHead(200, { 'Content-Type': mime });
        res.end(content);
      } catch { res.writeHead(404); res.end('Not found'); }
      return;
    }

    // ── Chrome shell ──────────────────────────────────────────────────────────

    const sessionMatch = method === 'GET' && pathname.match(/^\/session\/([^/]+)$/);
    if (sessionMatch) {
      const key = decodeURIComponent(sessionMatch[1]);
      const session = findByKey(key);
      if (!session) { res.writeHead(404); res.end('Session not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(createChromeHtml(session));
      return;
    }

    // ── Plan file serving ─────────────────────────────────────────────────────

    const planMatch = method === 'GET' && pathname.match(/^\/plan\/([^/]+)\/(.+)$/);
    if (planMatch) {
      const key = decodeURIComponent(planMatch[1]);
      const assetRel = planMatch[2];
      const session = findByKey(key);
      if (!session) { res.writeHead(404); res.end('Session not found'); return; }

      if (assetRel === 'index.html') {
        try {
          let html = readFileSync(session.file, 'utf8');
          const injection = `<script src="/browser/sdk.js?key=${encodeURIComponent(key)}"></script>`;
          html = html.includes('</body>')
            ? html.replace(/<\/body>/i, injection + '</body>')
            : html + injection;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch { res.writeHead(500); res.end('Could not read plan file'); }
        return;
      }

      const root = path.dirname(session.file);
      const resolved = path.resolve(root, assetRel);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      try {
        const content = readFileSync(resolved);
        const ext = path.extname(resolved).slice(1);
        const mimes = {
          html: 'text/html', css: 'text/css', js: 'text/javascript',
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          svg: 'image/svg+xml', gif: 'image/gif', woff2: 'font/woff2', woff: 'font/woff',
        };
        res.writeHead(200, { 'Content-Type': mimes[ext] ?? 'application/octet-stream' });
        res.end(content);
      } catch { res.writeHead(404); res.end('Not found'); }
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    process.stderr.write(`[planner] error: ${err.message}\n`);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  }
}

export function startServer() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[planner] server listening on http://127.0.0.1:${PORT}\n`);
  });
}
