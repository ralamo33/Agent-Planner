# Phase 1 — Store + Server Core

**Goal:** Working Express server with all API routes. Testable with `curl` — no browser, no CLI needed yet.

**Files to create:**
- `package.json`
- `src/store.js`
- `src/server.js`

**Do NOT create:** `bin/lavish`, `src/cli.js`, anything in `src/browser/`. Those are later phases.

---

## package.json

```json
{
  "name": "lavish",
  "version": "0.1.0",
  "type": "module",
  "bin": { "lavish": "./bin/lavish" },
  "dependencies": {
    "express": "^5.2.1",
    "open": "^10.2.0"
  }
}
```

Run `npm install` after creating this.

---

## src/store.js

Session persistence. Every exported function reads `~/.lavish/state.json` from disk, mutates in memory, writes back. No caching. This ensures sessions survive server restarts.

**Setup:**
```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.lavish');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function readState() {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function sessionKey(canonicalPath) {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
}
```

**Exports:**

`upsertSession(file)` — resolve to canonical path, compute key, create session if missing, return session object.

`takeFeedback(key)` — the critical method:
- Read state
- If key not found → return `{ status: 'missing' }`
- If status is `ended` AND no prompts/warnings → return `{ status: 'ended' }`
- If status is `ended` AND has prompts/warnings → extract them, clear them, write state, return `{ status: 'feedback', prompts, layout_warnings, dom_snapshot }`
- If status is `open` or `feedback` AND no prompts/warnings → return `{ status: 'waiting' }`
- If has prompts or warnings → extract, clear, set status back to `open`, clear dom_snapshot, write state, return `{ status: 'feedback', prompts, layout_warnings, dom_snapshot }`

`queuePrompts(key, prompts, domSnapshot)`:
- Read state, get session
- Append incoming prompts to `session.prompts`
- Set `session.dom_snapshot = domSnapshot`
- Set `session.status = 'feedback'`
- Increment `session.pending_prompts`
- For each prompt with `tag === 'message'` and non-empty `prompt` field, append `{ role: 'user', text: prompt.prompt, at: new Date().toISOString() }` to `session.chat`
- Write state

`recordLayoutWarnings(key, warnings)`:
- Read state, get session
- Set `session.layout_warnings = warnings`
- If warnings.length > 0, set `session.status = 'feedback'`
- Write state, return whether status changed to feedback

`addAgentReply(key, text)`:
- Read state, append `{ role: 'agent', text, at: new Date().toISOString() }` to session.chat, write state

`endSession(key)`:
- Read state, set session.status = 'ended', write state

`findByKey(key)`:
- Read state, return session or null

`listSessions()`:
- Read state, return `Object.values(state.sessions)`

---

## src/server.js

Express server on port 4387. Starts listening immediately when the file is run with `node src/server.js`.

**Imports and setup:**
```js
import express from 'express';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

const PORT = 4387;
const app = express();
app.use(express.json());

const events = new EventEmitter();
events.setMaxListeners(0);

const activePolls = new Map();   // key → count
const deliveredFeedback = new Set();
const sseClients = new Map();    // key → Set<res>
const fileWatchers = new Map();  // key → FSWatcher
```

**Presence helpers:**
```js
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
```

**SSE helpers:**
```js
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
```

**Idle shutdown:**
```js
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
```

**Routes:**

`GET /health`:
```js
app.get('/health', (req, res) => res.json({ ok: true, app: 'lavish' }));
```

`POST /shutdown`:
```js
app.post('/shutdown', (req, res) => {
  res.json({ ok: true });
  setImmediate(() => process.exit(0));
});
```

`POST /api/sessions`:
```js
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
```

`GET /api/poll?file=<path>`:
```js
app.get('/api/poll', async (req, res) => {
  const canonical = await realpath(path.resolve(String(req.query.file ?? '')));
  const key = store.sessionKey(canonical);

  const immediate = await store.takeFeedback(key);
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
  const respond = async () => {
    if (done || res.writableEnded) return;
    const result = await store.takeFeedback(key);
    if (result.status === 'feedback') markDelivered(key);
    res.end(JSON.stringify(result));
    cleanup();
  };

  events.once(`feedback:${key}`, respond);
  events.once(`ended:${key}`, respond);
  req.on('close', cleanup);
});
```

`POST /api/:key/prompts`:
```js
app.post('/api/:key/prompts', async (req, res) => {
  const { key } = req.params;
  const { prompts, dom_snapshot } = req.body;
  await store.queuePrompts(key, prompts, dom_snapshot);
  events.emit(`feedback:${key}`);
  res.json({ ok: true });
});
```

`POST /api/:key/layout-warnings`:
```js
app.post('/api/:key/layout-warnings', async (req, res) => {
  const { key } = req.params;
  const { layout_warnings } = req.body;
  const changed = await store.recordLayoutWarnings(key, layout_warnings);
  if (changed) events.emit(`feedback:${key}`);
  res.json({ ok: true });
});
```

`POST /api/:key/agent-reply`:
```js
app.post('/api/:key/agent-reply', async (req, res) => {
  const { key } = req.params;
  const { text } = req.body;
  await store.addAgentReply(key, text);
  broadcastEvent(key, 'agent-reply', { text });
  res.json({ ok: true });
});
```

`POST /api/end`:
```js
app.post('/api/end', async (req, res) => {
  const canonical = await realpath(path.resolve(String(req.body.file ?? '')));
  const key = store.sessionKey(canonical);
  await store.endSession(key);
  events.emit(`ended:${key}`);
  broadcastEvent(key, 'agent-presence', { state: 'waiting' });
  res.json({ ok: true });
});
```

`GET /events/:key` (SSE):
```js
app.get('/events/:key', async (req, res) => {
  const { key } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
  refreshIdleTimer();

  const session = await store.findByKey(key);
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
```

**Phase 1 stubs for browser routes (return 501):**
```js
for (const path of ['/session/:key', '/artifact/:key/index.html', '/sdk.js', '/chrome-client.js', '/chrome.css']) {
  app.get(path, (req, res) => res.status(501).send('Not implemented yet — Phase 3/4'));
}
app.get(/^\/artifact\/[^/]+\/.+$/, (req, res) => res.status(501).send('Not implemented yet — Phase 4'));
```

**Start listening:**
```js
app.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[lavish] server listening on http://127.0.0.1:${PORT}\n`);
});
```

---

## Verification

After `npm install`, run these in order:

```sh
# 1. Start server
node src/server.js &
sleep 1

# 2. Health check
curl -s http://127.0.0.1:4387/health
# → {"ok":true,"app":"lavish"}

# 3. Register a session
echo "<h1>Hello</h1>" > /tmp/test.html
curl -s -X POST http://127.0.0.1:4387/api/sessions \
  -H "Content-Type: application/json" \
  -d "{\"file\":\"/tmp/test.html\"}"
# → {"key":"<16-char-hex>","url":"http://127.0.0.1:4387/session/<key>"}
# Note the key for next steps

KEY=<paste key here>

# 4. Poll returns "waiting" immediately
curl -s "http://127.0.0.1:4387/api/poll?file=/tmp/test.html"
# → {"status":"waiting"}  (with leading space)

# 5. Queue a prompt in one terminal, poll in another
curl -s -X POST "http://127.0.0.1:4387/api/$KEY/prompts" \
  -H "Content-Type: application/json" \
  -d '{"prompts":[{"uid":"1","prompt":"Make it blue","tag":"message","selector":"h1","text":"Hello"}],"dom_snapshot":"uid=1 h1 Hello"}'
# → {"ok":true}

# 6. Poll now returns feedback
curl -s "http://127.0.0.1:4387/api/poll?file=/tmp/test.html"
# → {"status":"feedback","prompts":[...],"layout_warnings":[],"dom_snapshot":"uid=1 h1 Hello"}

# 7. State file exists and is readable
cat ~/.lavish/state.json

# 8. Shutdown
curl -s -X POST http://127.0.0.1:4387/shutdown
```

All 8 checks passing = Phase 1 complete. Proceed to Phase 2 (CLI).
