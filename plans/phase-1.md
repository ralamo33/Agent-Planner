# Phase 1 — Core: Store + Server

**Goal:** `planner.mjs` with the store and server sections working. Testable with `curl` — no browser, no client commands yet.

**Deliverable:** A single file `planner.mjs` that you can run with `node planner.mjs server` and verify with curl.

**Do NOT build yet:** browser serving routes, client commands (`open`/`poll`/`end`), browser files. Stub browser routes as 501.

---

## File: `planner.mjs`

Structure the file with section comments so later phases can slot in cleanly:

```js
// ─── 1. CONFIG ────────────────────────────────────────────────────────────────
// ─── 2. STORE ─────────────────────────────────────────────────────────────────
// ─── 3. SERVER ────────────────────────────────────────────────────────────────
// ─── 4. BROWSER OPEN ──────────────────────────────────────────── (phase 2)
// ─── 5. CLIENT COMMANDS ───────────────────────────────────────── (phase 2)
// ─── 6. ENTRY POINT ───────────────────────────────────────────────────────────
```

---

## Section 1: Config

```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const PORT = 4737;
const STATE_DIR = path.join(os.homedir(), '.planner');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const IDLE_MS = parseInt(process.env.PLANNER_IDLE_MS ?? '') || 30 * 60_000;
```

---

## Section 2: Store

All functions read from disk, mutate, write back. No memory cache.

```js
function readState() {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sessionKey(canonicalPath) {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
}

function upsertSession(canonicalFile) {
  const state = readState();
  const key = sessionKey(canonicalFile);
  if (!state.sessions[key]) {
    state.sessions[key] = {
      key,
      file: canonicalFile,
      url: `http://127.0.0.1:${PORT}/session/${key}`,
      status: 'open',
      pending_prompts: 0,
      prompts: [],
      layout_warnings: [],
      dom_snapshot: '',
      chat: [],
      updated_at: new Date().toISOString(),
    };
    writeState(state);
  }
  return state.sessions[key];
}

function takeFeedback(key) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return { status: 'missing' };

  const hasPrompts = session.prompts.length > 0;
  const hasWarnings = session.layout_warnings.length > 0;

  if (!hasPrompts && !hasWarnings) {
    return { status: session.status === 'ended' ? 'ended' : 'waiting' };
  }

  const result = {
    status: 'feedback',
    prompts: session.prompts,
    layout_warnings: session.layout_warnings,
    dom_snapshot: session.dom_snapshot,
  };
  session.prompts = [];
  session.layout_warnings = [];
  session.dom_snapshot = '';
  session.pending_prompts = 0;
  if (session.status !== 'ended') session.status = 'open';
  session.updated_at = new Date().toISOString();
  writeState(state);
  return result;
}

function queuePrompts(key, prompts, domSnapshot) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.prompts.push(...prompts);
  session.dom_snapshot = domSnapshot ?? session.dom_snapshot;
  session.status = 'feedback';
  session.pending_prompts = (session.pending_prompts ?? 0) + prompts.length;
  for (const p of prompts) {
    if (p.tag === 'message' && p.prompt) {
      session.chat.push({ role: 'user', text: p.prompt, at: new Date().toISOString() });
    }
  }
  session.updated_at = new Date().toISOString();
  writeState(state);
}

function recordLayoutWarnings(key, warnings) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return false;
  session.layout_warnings = warnings;
  const changed = warnings.length > 0;
  if (changed) session.status = 'feedback';
  session.updated_at = new Date().toISOString();
  writeState(state);
  return changed;
}

function addAgentReply(key, text) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.chat.push({ role: 'agent', text, at: new Date().toISOString() });
  session.updated_at = new Date().toISOString();
  writeState(state);
}

function endSession(key) {
  const state = readState();
  const session = state.sessions[key];
  if (!session) return;
  session.status = 'ended';
  session.updated_at = new Date().toISOString();
  writeState(state);
}

function findByKey(key) {
  return readState().sessions[key] ?? null;
}

function listSessions() {
  return Object.values(readState().sessions);
}
```

---

## Section 3: Server

Use `node:http` directly. Routing is a simple function that matches method + path prefix.

**Helpers:**

```js
const events = new EventEmitter();
events.setMaxListeners(0);

// Presence tracking
const activePolls = new Map();     // key → count
const deliveredFeedback = new Set();
const sseClients = new Map();      // key → Set<res>
const fileWatchers = new Map();    // key → FSWatcher

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

// SSE helpers
function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSse(key, event, data) {
  for (const res of sseClients.get(key) ?? []) sseEvent(res, event, data);
}

// Body parsing
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

// Simple router
function route(method, pathname, handler) {
  return { method, pathname, handler };
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}
```

**Request handler:**

```js
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // Health
    if (method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true, app: 'planner' });
    }

    // Shutdown
    if (method === 'POST' && pathname === '/shutdown') {
      send(res, 200, { ok: true });
      setImmediate(() => process.exit(0));
      return;
    }

    // Register session
    if (method === 'POST' && pathname === '/api/sessions') {
      const body = await readBody(req);
      const canonical = await realpath(path.resolve(body.file));
      const session = upsertSession(canonical);
      if (!fileWatchers.has(session.key)) {
        const w = watch(canonical, { persistent: false }, () => {
          broadcastSse(session.key, 'reload', {});
        });
        fileWatchers.set(session.key, w);
      }
      return send(res, 200, { key: session.key, url: session.url });
    }

    // Long-poll
    if (method === 'GET' && pathname === '/api/poll') {
      const file = url.searchParams.get('file');
      const canonical = await realpath(path.resolve(file));
      const key = sessionKey(canonical);

      const immediate = takeFeedback(key);
      if (immediate.status !== 'waiting') {
        if (immediate.status === 'feedback') markDelivered(key);
        return send(res, 200, immediate);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(' ');
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 15_000);
      heartbeat.unref?.();
      setActivePolls(key, +1);

      let done = false;
      const cleanup = () => {
        if (done) return; done = true;
        clearInterval(heartbeat);
        clearDelivered(key);
        setActivePolls(key, -1);
        events.off(`feedback:${key}`, respond);
        events.off(`ended:${key}`, respond);
      };
      const respond = () => {
        if (done || res.writableEnded) return;
        const result = takeFeedback(key);
        if (result.status === 'feedback') markDelivered(key);
        res.end(JSON.stringify(result));
        cleanup();
      };
      events.once(`feedback:${key}`, respond);
      events.once(`ended:${key}`, respond);
      req.on('close', cleanup);
      return;
    }

    // Queue prompts
    const promptsMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/prompts$/);
    if (promptsMatch) {
      const key = promptsMatch[1];
      const body = await readBody(req);
      queuePrompts(key, body.prompts ?? [], body.dom_snapshot ?? '');
      events.emit(`feedback:${key}`);
      return send(res, 200, { ok: true });
    }

    // Layout warnings
    const warningsMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/layout-warnings$/);
    if (warningsMatch) {
      const key = warningsMatch[1];
      const body = await readBody(req);
      const changed = recordLayoutWarnings(key, body.layout_warnings ?? []);
      if (changed) events.emit(`feedback:${key}`);
      return send(res, 200, { ok: true });
    }

    // Agent reply
    const replyMatch = method === 'POST' && pathname.match(/^\/api\/([^/]+)\/agent-reply$/);
    if (replyMatch) {
      const key = replyMatch[1];
      const body = await readBody(req);
      addAgentReply(key, body.text ?? '');
      broadcastSse(key, 'agent-reply', { text: body.text });
      return send(res, 200, { ok: true });
    }

    // End session
    if (method === 'POST' && pathname === '/api/end') {
      const body = await readBody(req);
      const canonical = await realpath(path.resolve(body.file));
      const key = sessionKey(canonical);
      endSession(key);
      events.emit(`ended:${key}`);
      broadcastSse(key, 'agent-presence', { state: 'waiting' });
      return send(res, 200, { ok: true });
    }

    // SSE
    const sseMatch = method === 'GET' && pathname.match(/^\/events\/([^/]+)$/);
    if (sseMatch) {
      const key = sseMatch[1];
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

    // Phase 3/4 stubs
    if (['/session/', '/artifact/', '/browser/'].some(p => pathname.startsWith(p))) {
      res.writeHead(501); res.end('Not implemented yet');
      return;
    }

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    process.stderr.write(`[planner] error: ${err.message}\n`);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  }
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`[planner] server listening on http://127.0.0.1:${PORT}\n`);
  });
}
```

---

## Section 6: Entry point (phase 1 stub)

```js
const cmd = process.argv[2];
if (cmd === 'server') {
  startServer();
} else {
  process.stderr.write('Phase 2 not built yet — client commands coming soon.\n');
  process.exit(1);
}
```

---

## Verification

```sh
# Start server
node planner.mjs server &
sleep 1

# 1. Health
curl -s http://127.0.0.1:4737/health
# → {"ok":true,"app":"planner"}

# 2. Register session
echo "<h1>Hello</h1>" > /tmp/test.html
curl -s -X POST http://127.0.0.1:4737/api/sessions \
  -H "Content-Type: application/json" \
  -d "{\"file\":\"/tmp/test.html\"}"
# → {"key":"<16-char-hex>","url":"..."}

export KEY=<paste key>

# 3. Poll with nothing queued → waiting
curl -s "http://127.0.0.1:4737/api/poll?file=/tmp/test.html"
# → (leading space) {"status":"waiting"}

# 4. Queue a prompt
curl -s -X POST "http://127.0.0.1:4737/api/$KEY/prompts" \
  -H "Content-Type: application/json" \
  -d '{"prompts":[{"uid":"1","prompt":"Make it blue","tag":"message","selector":"h1","text":"Hello"}],"dom_snapshot":"uid=1 h1 Hello"}'
# → {"ok":true}

# 5. Poll now returns feedback
curl -s "http://127.0.0.1:4737/api/poll?file=/tmp/test.html"
# → {"status":"feedback","prompts":[...],"layout_warnings":[],"dom_snapshot":"uid=1 h1 Hello"}

# 6. State file written to disk
cat ~/.planner/state.json

# 7. Shutdown
curl -s -X POST http://127.0.0.1:4737/shutdown
```

All 7 checks passing = Phase 1 complete.
