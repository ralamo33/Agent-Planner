# Phase 3 — Chrome Shell + SSE

**Goal:** The browser opens to a real UI — conversation panel, presence indicator, Send button. The iframe loads the plan (as 501 stub for now; Phase 4 fixes it). SSE delivers presence state and chat history live.

**Prerequisite:** Phase 2 complete — `node planner.mjs open plan.html` works and auto-spawns the server.

**Files to create:** `browser/chrome.js`, `browser/chrome.css`
**Files to modify:** `planner.mjs` — add `/session/:key` and `/browser/:file` routes, remove those stubs

---

## `planner.mjs` additions

### Route: `GET /browser/:file`

Serves static files from the `browser/` directory next to `planner.mjs`. Only allows whitelisted filenames to avoid traversal.

```js
const BROWSER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser');
const BROWSER_FILES = { 'chrome.js': 'text/javascript', 'chrome.css': 'text/css', 'sdk.js': 'text/javascript' };

// In handleRequest:
const browserMatch = method === 'GET' && pathname.match(/^\/browser\/([^/]+)$/);
if (browserMatch) {
  const filename = browserMatch[1];
  const mime = BROWSER_FILES[filename];
  if (!mime) { res.writeHead(403); res.end('Forbidden'); return; }
  const filePath = path.join(BROWSER_DIR, filename);
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
  return;
}
```

**Note:** `fileURLToPath` and `import.meta.url` must be used at module top level. Add to Section 1 imports:
```js
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = path.join(__dirname, 'browser');
```

### Route: `GET /session/:key`

Generates and serves the chrome shell HTML.

```js
const sessionMatch = method === 'GET' && pathname.match(/^\/session\/([^/]+)$/);
if (sessionMatch) {
  const key = sessionMatch[1];
  const session = findByKey(key);
  if (!session) { res.writeHead(404); res.end('Session not found'); return; }
  const html = createChromeHtml(session);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
  return;
}
```

```js
function createChromeHtml(session) {
  const basename = path.basename(session.file);
  const sessionData = JSON.stringify({
    key: session.key,
    file: session.file,
    initialChat: session.chat ?? [],
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Planner — ${basename}</title>
  <link rel="stylesheet" href="/browser/chrome.css">
</head>
<body>
  <div class="bar">
    <span class="brand">Planner</span>
    <span class="filename">${basename}</span>
    <label class="annotate-toggle">
      <input type="checkbox" id="annotateToggle"> Annotate
    </label>
  </div>
  <div class="layout">
    <div class="frame">
      <iframe id="planFrame"
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        data-plan-src="/plan/${session.key}/index.html"
        title="Plan preview"></iframe>
    </div>
    <aside class="panel">
      <div class="chat" id="chatLog"></div>
      <div class="composer">
        <div class="presence-banner" id="presenceBanner" hidden>
          Agent is not listening yet
        </div>
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
      <p>The agent has finished this review.</p>
    </div>
  </div>
  <script id="planner-session" type="application/json">${sessionData}</script>
  <script src="/browser/chrome.js"></script>
</body>
</html>`;
}
```

Also remove `/session/` and `/plan/` from the Phase 1 501 stubs (leave `/plan/` stub — Phase 4 will fill it):
```js
// Phase 1 stub — update to only catch /plan/ (session is now handled above)
if (pathname.startsWith('/plan/')) {
  res.writeHead(501); res.end('Not implemented yet — Phase 4');
  return;
}
```

---

## `browser/chrome.js`

Plain browser JS, no imports, no build step. Runs as a classic script.

### Startup sequence

```js
(function () {
  const session = JSON.parse(document.getElementById('planner-session').textContent);
  const { key, file, initialChat } = session;

  const frame = document.getElementById('planFrame');
  const chatLog = document.getElementById('chatLog');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const endBtn = document.getElementById('endBtn');
  const presenceBanner = document.getElementById('presenceBanner');
  const annotateToggle = document.getElementById('annotateToggle');
  const annotationPills = document.getElementById('annotationPills');
  const endedOverlay = document.getElementById('endedOverlay');

  // State
  let queued = JSON.parse(sessionStorage.getItem(`planner:queued:${key}`) ?? '[]');
  let agentPresence = 'waiting';
  let ended = false;
  let pendingSnapshot = null;
  let snapshotResolve = null;

  // Load the plan iframe
  function loadFrame() {
    frame.src = frame.dataset.planSrc;
  }
  loadFrame();

  // Render initial chat
  renderChat(initialChat);

  // Connect SSE
  connectSse();

  // Render queued pill count
  renderPills();
  updateSendButton();
})();
```

### Chat rendering

```js
function renderChat(messages) {
  chatLog.innerHTML = '';
  for (const msg of messages) appendChatBubble(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendChatBubble(msg) {
  const div = document.createElement('div');
  div.className = `bubble bubble-${msg.role}`;
  div.textContent = msg.text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
```

### SSE connection

```js
function connectSse() {
  const es = new EventSource(`/events/${key}`);

  es.addEventListener('chat-sync', e => {
    const { chat } = JSON.parse(e.data);
    renderChat(chat);
  });

  es.addEventListener('agent-presence', e => {
    const { state } = JSON.parse(e.data);
    setPresence(state);
  });

  es.addEventListener('agent-reply', e => {
    const { text } = JSON.parse(e.data);
    appendChatBubble({ role: 'agent', text });
  });

  es.addEventListener('reload', () => {
    frame.src = frame.dataset.planSrc;
  });

  es.addEventListener('chrome-reload', () => {
    location.reload();
  });

  es.onerror = () => {
    setTimeout(connectSse, 2000);  // reconnect on error
    es.close();
  };
}
```

### Presence

```js
function setPresence(state) {
  agentPresence = state;
  presenceBanner.hidden = state !== 'waiting';
  presenceBanner.textContent = state === 'waiting'
    ? 'Agent is not listening yet'
    : state === 'working'
    ? 'Agent is working…'
    : '';
  updateSendButton();
}

function updateSendButton() {
  sendBtn.disabled = ended || agentPresence === 'working' || (queued.length === 0 && !chatInput.value.trim());
}
```

### Queue management

```js
function persistQueue() {
  sessionStorage.setItem(`planner:queued:${key}`, JSON.stringify(queued));
}

function enqueuePrompt(prompt) {
  const queueKey = prompt._plannerQueueKey?.trim();
  if (queueKey) {
    const idx = queued.findIndex(p => p._plannerQueueKey === queueKey);
    if (idx !== -1) { queued[idx] = prompt; persistQueue(); renderPills(); return; }
  }
  queued.push(prompt);
  persistQueue();
  renderPills();
}

function renderPills() {
  annotationPills.innerHTML = '';
  for (const p of queued) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = p.selector ?? p.tag ?? 'note';
    pill.title = p.prompt;
    annotationPills.appendChild(pill);
  }
  updateSendButton();
}
```

### Submit flow

```js
async function submit() {
  if (sendBtn.disabled) return;

  const text = chatInput.value.trim();
  const allPrompts = [...queued];
  if (text) {
    allPrompts.push({ uid: String(Date.now()), prompt: text, tag: 'message', selector: '', text: '' });
  }
  if (allPrompts.length === 0) return;

  // Request DOM snapshot from iframe
  let snapshot = '';
  try {
    snapshot = await requestSnapshot();
  } catch {}

  // Strip internal fields before sending
  const clean = allPrompts.map(p => {
    const { _plannerQueueKey, ...rest } = p;
    return rest;
  });

  try {
    await fetch(`/api/${key}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: clean, dom_snapshot: snapshot }),
    });
    queued = [];
    persistQueue();
    chatInput.value = '';
    renderPills();
    updateSendButton();
  } catch (err) {
    console.error('[planner] submit failed', err);
  }
}

function requestSnapshot() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('snapshot timeout')), 3000);
    snapshotResolve = (snapshot) => {
      clearTimeout(timeout);
      snapshotResolve = null;
      resolve(snapshot);
    };
    postToFrame({ type: 'planner:requestSnapshot' });
  });
}

function postToFrame(msg) {
  frame.contentWindow?.postMessage(msg, '*');
}
```

### postMessage from iframe

```js
window.addEventListener('message', (e) => {
  const { type } = e.data ?? {};

  if (type === 'planner:queuePrompt') {
    enqueuePrompt(e.data.prompt);
  }

  if (type === 'planner:snapshot') {
    snapshotResolve?.(e.data.snapshot ?? '');
  }

  if (type === 'planner:scroll') {
    // Store scroll position for restore after reload
    sessionStorage.setItem(`planner:scroll:${key}`, JSON.stringify({ x: e.data.x, y: e.data.y }));
  }

  if (type === 'planner:layoutWarnings') {
    // Phase 5 handles this — ignore for now
  }
});
```

### Event listeners

```js
sendBtn.addEventListener('click', submit);

chatInput.addEventListener('input', updateSendButton);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
});

annotateToggle.addEventListener('change', () => {
  postToFrame({ type: 'planner:setAnnotationMode', enabled: annotateToggle.checked });
});

endBtn.addEventListener('click', async () => {
  if (!confirm('End this session?')) return;
  await fetch(`/api/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  ended = true;
  endedOverlay.hidden = false;
  updateSendButton();
});

frame.addEventListener('load', () => {
  // Re-send annotation mode state after reload
  postToFrame({ type: 'planner:setAnnotationMode', enabled: annotateToggle.checked });
  // Restore scroll
  const saved = sessionStorage.getItem(`planner:scroll:${key}`);
  if (saved) {
    const { x, y } = JSON.parse(saved);
    postToFrame({ type: 'planner:restoreScroll', x, y });
  }
});
```

---

## `browser/chrome.css`

Key layout rules (fill in with complete styles):

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body { height: 100%; overflow: hidden; font-family: system-ui, sans-serif; background: #f5f5f5; }

/* Top bar */
.bar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px; background: #1a1a1a; color: #fff;
  height: 44px; flex-shrink: 0;
}
.brand { font-weight: 600; font-size: 14px; }
.filename { font-size: 12px; color: #aaa; flex: 1; }
.annotate-toggle { font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; }

/* Main layout */
.layout { display: flex; height: calc(100vh - 44px); }

/* Iframe frame */
.frame { flex: 1; position: relative; background: #fff; }
.frame iframe { width: 100%; height: 100%; border: none; display: block; }

/* Conversation panel */
.panel {
  width: 320px; flex-shrink: 0;
  display: flex; flex-direction: column;
  border-left: 1px solid #ddd; background: #fff;
}
.chat { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }

/* Chat bubbles */
.bubble { max-width: 90%; padding: 8px 12px; border-radius: 12px; font-size: 13px; line-height: 1.4; word-break: break-word; }
.bubble-user { background: #e8f0fe; align-self: flex-end; border-bottom-right-radius: 4px; }
.bubble-agent { background: #f0f0f0; align-self: flex-start; border-bottom-left-radius: 4px; }

/* Composer */
.composer { padding: 12px; border-top: 1px solid #eee; display: flex; flex-direction: column; gap: 8px; }
.presence-banner { font-size: 12px; color: #888; padding: 6px 8px; background: #fffbe6; border-radius: 6px; border: 1px solid #ffe58f; }
.annotation-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { background: #e8f0fe; color: #1a73e8; font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.composer textarea { resize: none; border: 1px solid #ddd; border-radius: 8px; padding: 8px; font-size: 13px; font-family: inherit; }
.composer textarea:focus { outline: none; border-color: #1a73e8; }

/* Send row */
.send-row { display: flex; gap: 8px; }
.send-row button { flex: 1; padding: 8px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; }
#sendBtn { background: #1a73e8; color: #fff; }
#sendBtn:disabled { background: #ccc; cursor: not-allowed; }
#endBtn { background: #f5f5f5; color: #666; }
#endBtn:hover { background: #eee; }

/* Ended overlay */
.ended-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.ended-overlay[hidden] { display: none; }
.ended-box { background: #fff; padding: 32px; border-radius: 16px; text-align: center; }
.ended-box h2 { margin-bottom: 8px; }
.ended-box p { color: #666; font-size: 14px; }
```

---

## Verification

```sh
# 1. Start server and open plan
echo "<h1>My Plan</h1><p>Some content here.</p>" > /tmp/plan.html
node planner.mjs open /tmp/plan.html
# → Browser opens

# 2. Chrome UI loads
# - Top bar visible with "Planner" brand and filename
# - Iframe shows 501 (Phase 4 fixes this)
# - Conversation panel visible on right
# - "Agent is not listening yet" banner visible
# - Send button disabled

# 3. Start a poll in another terminal
node planner.mjs poll /tmp/plan.html &
# → Presence banner disappears, Send button still disabled (no text/annotations yet)

# 4. Type a message and send
# - Type in textarea → Send button enables
# - Click Send → message submitted, chat bubble appears in panel

# 5. Poll terminal receives the feedback JSON and exits

# 6. SSE reload on file change
echo "<h1>Updated Plan</h1>" > /tmp/plan.html
# → Iframe reloads automatically (visible in browser)

# 7. End session
# - Click "End Session" → confirm dialog → "Session ended" overlay appears
```

All 7 checks passing = Phase 3 complete. Proceed to Phase 4 (Plan SDK + injection).
