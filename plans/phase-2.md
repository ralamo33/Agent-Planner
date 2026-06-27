# Phase 2 — Client Commands

**Goal:** Add sections 4–6 to `planner.mjs` so `node planner.mjs open/poll/end` work from the terminal.

**Prerequisite:** Phase 1 complete — server starts with `node planner.mjs server` and passes all curl checks.

---

## What gets added to `planner.mjs`

Phase 2 fills in the three stubs left in Phase 1:

```js
// ─── 4. BROWSER OPEN ──────────────────────────────────────────────────────────
// ─── 5. CLIENT COMMANDS ───────────────────────────────────────────────────────
// ─── 6. ENTRY POINT ───────────────────────────────────────────────────────────
```

The entry point stub from Phase 1 (`if (cmd === 'server') startServer(); else ...`) gets replaced with the full dispatcher.

---

## Section 4: Browser open

Cross-platform, no dependencies — use `child_process.spawn` to call the OS's native open command:

```js
import { spawn } from 'node:child_process';

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}
```

---

## Section 5: Client commands

### `fetchJson(url, options)` helper

Used by all client commands to talk to the server. The poll response has leading whitespace before the JSON — `data.trim()` before `JSON.parse` handles this cleanly.

```js
const BASE = 'http://127.0.0.1:4737';

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
```

### `ensureServer()`

1. Try `GET /health` — if it responds with `{ ok: true }`, return immediately
2. Otherwise spawn `node <this file> server` detached
3. Poll health every 100ms for up to 5s
4. Throw if still not up

```js
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
```

### `cmdOpen(args)`

```js
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
```

### `cmdPoll(args)`

```js
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
```

### `cmdEnd(args)`

```js
async function cmdEnd(args) {
  const file = args[0];
  if (!file) { process.stderr.write('Usage: node planner.mjs end <file>\n'); process.exit(1); }
  const canonical = await realpath(path.resolve(file));
  await ensureServer();
  await fetchJson(`${BASE}/api/end`, { method: 'POST', body: JSON.stringify({ file: canonical }) });
  console.log(JSON.stringify({ session: { file: canonical, status: 'ended' } }));
}
```

---

## Section 6: Entry point (full — replaces Phase 1 stub)

```js
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
```

---

## Verification

```sh
# 1. Open — browser opens (shows 501 for now, Phase 3 fixes that)
echo "<h1>My Plan</h1>" > /tmp/plan.html
node planner.mjs open /tmp/plan.html
# → JSON with session.url and next_step

# 2. Poll blocks
node planner.mjs poll /tmp/plan.html
# stderr: "[planner] waiting for feedback on /tmp/plan.html..."
# process hangs — correct. Ctrl+C to cancel.

# 3. Queue feedback then poll
KEY=$(node planner.mjs open /tmp/plan.html | node -e "process.stdin.resume();process.stdin.on('data',d=>console.log(JSON.parse(d).session.key))")
curl -s -X POST "http://127.0.0.1:4737/api/$KEY/prompts" \
  -H "Content-Type: application/json" \
  -d '{"prompts":[{"uid":"1","prompt":"Looks good","tag":"message","selector":"h1","text":"My Plan"}],"dom_snapshot":""}'
node planner.mjs poll /tmp/plan.html
# → JSON with status: "feedback", prompts, next_step

# 4. Agent reply + poll
node planner.mjs poll /tmp/plan.html --agent-reply "Thanks, updated!"
# → POSTs reply to server, then blocks for more feedback. Ctrl+C to cancel.

# 5. End session
node planner.mjs end /tmp/plan.html
# → {"session":{"file":"...","status":"ended"}}

# 6. Version
node planner.mjs --version
# → 0.1.0

# 7. Server auto-spawns when not running
pkill -f "planner.mjs server" 2>/dev/null; sleep 1
node planner.mjs open /tmp/plan.html
curl -s http://127.0.0.1:4737/health
# → {"ok":true,"app":"planner"}
```

All 7 checks passing = Phase 2 complete. Proceed to Phase 3 (Chrome shell + SSE).
