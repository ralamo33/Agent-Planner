import express from 'express';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

const PORT = parseInt(process.env.LAVISH_PORT ?? '') || 4387;
const app = express();
app.use(express.json());

const events = new EventEmitter();
events.setMaxListeners(0);

const activePolls = new Map();
const deliveredFeedback = new Set();
const sseClients = new Map();
const fileWatchers = new Map();

// --- Presence ---

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
  if (prev !== after) broadcastPresence(key, after);
}

function markDelivered(key) {
  deliveredFeedback.add(key);
  broadcastPresence(key, 'working');
}

function clearDelivered(key) {
  deliveredFeedback.delete(key);
}

// --- SSE ---

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastPresence(key, state) {
  for (const res of sseClients.get(key) ?? []) {
    sseWrite(res, 'agent-presence', { state });
  }
}

function broadcastEvent(key, event, data) {
  for (const res of sseClients.get(key) ?? []) {
    sseWrite(res, event, data);
  }
}

// --- Idle shutdown ---

const IDLE_MS = parseInt(process.env.LAVISH_IDLE_TIMEOUT_MS ?? '') || 30 * 60_000;
let idleTimer = null;

function refreshIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const hasClients = [...sseClients.values()].some(s => s.size > 0);
  const hasPolls = activePolls.size > 0;
  if (hasClients || hasPolls) return;
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
  idleTimer?.unref?.();
}

// --- Routes ---

app.get('/health', (req, res) => res.json({ ok: true, app: 'lavish' }));

app.post('/shutdown', (req, res) => {
  res.json({ ok: true });
  setImmediate(() => process.exit(0));
});

app.post('/api/sessions', async (req, res) => {
  const { file } = req.body;
  const canonical = await realpath(path.resolve(file));
  const session = await store.upsertSession(canonical);
  if (!fileWatchers.has(session.key)) {
    const w = watch(canonical, { persistent: false }, () => {
      broadcastEvent(session.key, 'reload', {});
    });
    fileWatchers.set(session.key, w);
  }
  res.json({ key: session.key, url: session.url });
});

app.get('/api/poll', async (req, res) => {
  const canonical = await realpath(path.resolve(String(req.query.file ?? '')));
  const key = store.sessionKey(canonical);

  const immediate = store.takeFeedback(key);
  if (immediate.status !== 'waiting') {
    if (immediate.status === 'feedback') markDelivered(key);
    return res.json(immediate);
  }

  res.status(200).type('application/json');
  res.write(' ');
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 15_000);
  heartbeat.unref?.();
  setActivePolls(key, +1);
  refreshIdleTimer();

  let done = false;
  const cleanup = () => {
    if (done) return; done = true;
    clearInterval(heartbeat);
    setActivePolls(key, -1);
    clearDelivered(key);
    events.off(`feedback:${key}`, respond);
    events.off(`ended:${key}`, respond);
    refreshIdleTimer();
  };
  const respond = () => {
    if (done || res.writableEnded) return;
    const result = store.takeFeedback(key);
    if (result.status === 'feedback') markDelivered(key);
    res.end(JSON.stringify(result));
    cleanup();
  };

  events.once(`feedback:${key}`, respond);
  events.once(`ended:${key}`, respond);
  req.on('close', cleanup);
});

app.post('/api/:key/prompts', (req, res) => {
  const { key } = req.params;
  const { prompts, dom_snapshot } = req.body;
  store.queuePrompts(key, prompts, dom_snapshot);
  events.emit(`feedback:${key}`);
  res.json({ ok: true });
});

app.post('/api/:key/layout-warnings', (req, res) => {
  const { key } = req.params;
  const { layout_warnings } = req.body;
  const changed = store.recordLayoutWarnings(key, layout_warnings);
  if (changed) events.emit(`feedback:${key}`);
  res.json({ ok: true });
});

app.post('/api/:key/agent-reply', (req, res) => {
  const { key } = req.params;
  const { text } = req.body;
  store.addAgentReply(key, text);
  broadcastEvent(key, 'agent-reply', { text });
  res.json({ ok: true });
});

app.post('/api/end', async (req, res) => {
  const canonical = await realpath(path.resolve(String(req.body.file ?? '')));
  const key = store.sessionKey(canonical);
  store.endSession(key);
  events.emit(`ended:${key}`);
  broadcastEvent(key, 'agent-presence', { state: 'waiting' });
  res.json({ ok: true });
});

app.get('/events/:key', async (req, res) => {
  const { key } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  refreshIdleTimer();

  const session = store.findByKey(key);
  sseWrite(res, 'chat-sync', { chat: session?.chat ?? [] });
  sseWrite(res, 'agent-presence', { state: computePresence(key) });

  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  keepalive.unref?.();

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.get(key)?.delete(res);
    refreshIdleTimer();
  });
});

// Phase 1 stubs — browser routes implemented in Phase 3/4
for (const p of ['/session/:key', '/artifact/:key/index.html', '/sdk.js', '/chrome-client.js', '/chrome.css']) {
  app.get(p, (req, res) => res.status(501).send('Not implemented yet — Phase 3/4'));
}
app.get(/^\/artifact\/[^/]+\/.+$/, (req, res) => res.status(501).send('Not implemented yet — Phase 4'));

app.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[lavish] server listening on http://127.0.0.1:${PORT}\n`);
});
