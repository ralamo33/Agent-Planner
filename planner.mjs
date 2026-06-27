// ─── 1. CONFIG ────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const PORT = 4737;
const STATE_DIR = path.join(os.homedir(), '.planner');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const IDLE_MS = parseInt(process.env.PLANNER_IDLE_MS ?? '') || 30 * 60_000;

// ─── 2. STORE ─────────────────────────────────────────────────────────────────

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

// ─── 3. SERVER ────────────────────────────────────────────────────────────────

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
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
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

    if (method === 'POST' && pathname === '/api/end') {
      const body = await readBody(req);
      const canonical = await realpath(path.resolve(body.file));
      const key = sessionKey(canonical);
      endSession(key);
      events.emit(`ended:${key}`);
      broadcastSse(key, 'agent-presence', { state: 'waiting' });
      return send(res, 200, { ok: true });
    }

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

    if (['/session/', '/plan/', '/browser/'].some(p => pathname.startsWith(p))) {
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

// ─── 4. BROWSER OPEN ──────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// ─── 5. CLIENT COMMANDS ───────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${PORT}`;

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data.trim())); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function ensureServer() {
  try {
    const res = await fetchJson(`${BASE}/health`);
    if (res.ok) return;
  } catch {}

  const { fileURLToPath } = await import('node:url');
  const self = fileURLToPath(import.meta.url);
  spawn(process.execPath, [self, 'server'], { detached: true, stdio: 'ignore' }).unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const res = await fetchJson(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
  }
  throw new Error('[planner] server did not start within 5s');
}

async function cmdOpen(args) {
  const file = args[0];
  if (!file) { process.stderr.write('Usage: node planner.mjs open <file>\n'); process.exit(1); }
  const canonical = await realpath(path.resolve(file));
  await ensureServer();
  const session = await fetchJson(`${BASE}/api/sessions`, {
    method: 'POST',
    body: JSON.stringify({ file: canonical }),
  });
  openBrowser(session.url);
  console.log(JSON.stringify({
    session: { file: canonical, key: session.key, url: session.url, status: 'opened' },
    next_step: `Run \`node planner.mjs poll ${file}\` to wait for feedback.`,
  }));
}

async function cmdPoll(args) {
  const file = args.find(a => !a.startsWith('-'));
  if (!file) { process.stderr.write('Usage: node planner.mjs poll <file> [--agent-reply "..."]\n'); process.exit(1); }
  const canonical = await realpath(path.resolve(file));
  const key = sessionKey(canonical);
  await ensureServer();

  const replyIdx = args.indexOf('--agent-reply');
  if (replyIdx !== -1 && args[replyIdx + 1]) {
    await fetchJson(`${BASE}/api/${key}/agent-reply`, {
      method: 'POST',
      body: JSON.stringify({ text: args[replyIdx + 1] }),
    });
  }

  process.stderr.write(`[planner] waiting for feedback on ${file}...\n`);
  const result = await fetchJson(`${BASE}/api/poll?file=${encodeURIComponent(canonical)}`);

  console.log(JSON.stringify({
    session: { file: canonical, status: result.status },
    ...result,
    next_step: buildNextStep(file, result),
  }));
}

function buildNextStep(file, result) {
  if (result.status === 'ended') return 'Session ended.';
  if (result.status === 'waiting') return `No feedback yet. Re-run \`node planner.mjs poll ${file}\`.`;
  const hasErrors = (result.layout_warnings ?? []).some(w => w.severity === 'error');
  if (hasErrors) return `Fix layout errors in ${file} first, then re-run poll.`;
  return `Apply feedback to ${file}, then run \`node planner.mjs poll ${file} --agent-reply "what you changed"\`.`;
}

async function cmdEnd(args) {
  const file = args[0];
  if (!file) { process.stderr.write('Usage: node planner.mjs end <file>\n'); process.exit(1); }
  const canonical = await realpath(path.resolve(file));
  await ensureServer();
  await fetchJson(`${BASE}/api/end`, { method: 'POST', body: JSON.stringify({ file: canonical }) });
  console.log(JSON.stringify({ session: { file: canonical, status: 'ended' } }));
}

// ─── 6. ENTRY POINT ───────────────────────────────────────────────────────────

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (!cmd || cmd === '--help') {
  process.stderr.write('Usage: node planner.mjs open|poll|end|server <file>\n');
  process.exit(0);
}

if (cmd === '--version') {
  console.log('0.1.0');
  process.exit(0);
}

if (cmd === 'server') {
  startServer();
} else if (cmd === 'open') {
  cmdOpen(args).catch(err => { process.stderr.write(`[planner] ${err.message}\n`); process.exit(1); });
} else if (cmd === 'poll') {
  cmdPoll(args).catch(err => { process.stderr.write(`[planner] ${err.message}\n`); process.exit(1); });
} else if (cmd === 'end') {
  cmdEnd(args).catch(err => { process.stderr.write(`[planner] ${err.message}\n`); process.exit(1); });
} else {
  process.stderr.write(`[planner] unknown command: ${cmd}\n`);
  process.exit(1);
}
