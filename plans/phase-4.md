# Phase 4 — Plan SDK + Injection

**Goal:** The plan HTML loads in the iframe with the SDK injected. Clicking elements shows annotation cards. Submitting annotations delivers them to `lavish poll` output.

**Prerequisite:** Phase 3 complete — chrome shell loads, SSE works, Send button submits prompts.

**Files to create:** `browser/sdk.js`
**Files to modify:** `planner.mjs` — add `/plan/:key/index.html` and `/plan/:key/*` routes

---

## `planner.mjs` additions

Replace the Phase 3 `/plan/` 501 stub with real routes:

### `GET /plan/:key/index.html` — serve plan with SDK injected

```js
const planMatch = method === 'GET' && pathname.match(/^\/plan\/([^/]+)\/index\.html$/);
if (planMatch) {
  const key = planMatch[1];
  const session = findByKey(key);
  if (!session) { res.writeHead(404); res.end('Session not found'); return; }
  try {
    let html = readFileSync(session.file, 'utf8');
    const injection = `<script src="/browser/sdk.js?key=${encodeURIComponent(key)}"></script>`;
    html = html.includes('</body>')
      ? html.replace(/<\/body>/i, `${injection}</body>`)
      : html + injection;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500); res.end('Could not read plan file');
  }
  return;
}
```

### `GET /plan/:key/*` — serve sibling assets with path traversal guard

```js
const assetMatch = method === 'GET' && pathname.match(/^\/plan\/([^/]+)\/(.+)$/);
if (assetMatch) {
  const key = assetMatch[1];
  const assetPath = assetMatch[2];
  const session = findByKey(key);
  if (!session) { res.writeHead(404); res.end('Not found'); return; }

  const root = path.dirname(session.file);
  const resolved = path.resolve(root, assetPath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const content = readFileSync(resolved);
    const ext = path.extname(resolved).slice(1);
    const mimes = { html: 'text/html', css: 'text/css', js: 'text/javascript',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', gif: 'image/gif', woff2: 'font/woff2' };
    res.writeHead(200, { 'Content-Type': mimes[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
  return;
}
```

---

## `browser/sdk.js`

Plain browser IIFE — no imports, no module syntax, no closure over anything outside. Loaded via `<script src="/browser/sdk.js?key=...">` injected at serve time.

### Overall structure

```js
(function () {
  const key = new URL(document.currentScript.src, location.href).searchParams.get('key');
  if (!key) return;

  // ── UID tracking ──────────────────────────────────────────────────────────
  // ── Selector generation ───────────────────────────────────────────────────
  // ── DOM snapshot ──────────────────────────────────────────────────────────
  // ── Annotation card (Shadow DOM) ──────────────────────────────────────────
  // ── Annotation mode ───────────────────────────────────────────────────────
  // ── postMessage bridge ────────────────────────────────────────────────────
  // ── window.planner API ────────────────────────────────────────────────────
  // ── Init ─────────────────────────────────────────────────────────────────
})();
```

### UID tracking

Assign a stable integer UID to each DOM element via WeakMap. Used in the DOM snapshot and in `PromptItem.uid`.

```js
const uidMap = new WeakMap();
let uidCounter = 0;

function uid(el) {
  if (!uidMap.has(el)) uidMap.set(el, ++uidCounter);
  return String(uidMap.get(el));
}
```

### Selector generation

Walk up the DOM from `el`, stop at an element with an `id` (use `#id`) or after 5 ancestors. Build a CSS path.

```js
function generateSelector(el) {
  const parts = [];
  let node = el;
  for (let i = 0; i < 6 && node && node !== document.documentElement; i++) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    let part = node.tagName.toLowerCase();
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      part += cls;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}
```

### DOM snapshot

A compact text representation of the visible DOM tree, with UIDs.

```js
function buildSnapshot(root, depth) {
  root = root ?? document.body;
  depth = depth ?? 0;
  const lines = [];
  for (const child of root.children) {
    const tag = child.tagName.toLowerCase();
    const text = (child.innerText ?? '').trim().slice(0, 80).replace(/\n/g, ' ');
    const indent = '  '.repeat(depth);
    lines.push(`${indent}uid=${uid(child)} ${tag}${text ? ' "' + text + '"' : ''}`);
    if (child.children.length && depth < 5) {
      lines.push(...buildSnapshot(child, depth + 1).split('\n').filter(Boolean));
    }
  }
  return lines.join('\n');
}
```

### Annotation card (Shadow DOM)

The card renders inside a Shadow DOM host so its styles don't leak into the plan and the plan's styles don't affect it.

```js
let cardHost = null;
let currentTarget = null;

function showAnnotationCard(el, options = {}) {
  removeAnnotationCard();
  currentTarget = el;

  cardHost = document.createElement('div');
  cardHost.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
  document.documentElement.appendChild(cardHost);

  const shadow = cardHost.attachShadow({ mode: 'open' });
  const rect = el.getBoundingClientRect();

  shadow.innerHTML = `
    <style>
      .card {
        position: fixed;
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,.15);
        padding: 12px;
        width: 260px;
        pointer-events: all;
        font-family: system-ui, sans-serif;
        font-size: 13px;
      }
      .meta { color: #888; margin-bottom: 8px; font-size: 11px; }
      textarea {
        width: 100%; border: 1px solid #ddd; border-radius: 6px;
        padding: 6px; font-size: 13px; font-family: inherit;
        resize: none; margin-bottom: 8px;
      }
      textarea:focus { outline: none; border-color: #1a73e8; }
      .row { display: flex; gap: 6px; }
      button { flex: 1; padding: 6px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
      .queue { background: #1a73e8; color: #fff; font-weight: 500; }
      .cancel { background: #f5f5f5; color: #444; }
    </style>
    <div class="card" style="top:${Math.min(rect.bottom + 8, window.innerHeight - 220)}px;left:${Math.min(rect.left, window.innerWidth - 280)}px">
      <div class="meta">${el.tagName.toLowerCase()}${options.isText ? ' · text selection' : ''}</div>
      <textarea id="noteInput" placeholder="Add a note…" rows="3"></textarea>
      <div class="row">
        <button class="queue" id="queueBtn">Queue</button>
        <button class="cancel" id="cancelBtn">Cancel</button>
      </div>
    </div>`;

  const noteInput = shadow.getElementById('noteInput');
  noteInput.focus();

  shadow.getElementById('queueBtn').addEventListener('click', () => {
    const note = noteInput.value.trim();
    const prompt = {
      uid: uid(el),
      prompt: note,
      selector: generateSelector(el),
      tag: options.isText ? 'text' : el.tagName.toLowerCase(),
      text: (el.innerText ?? '').trim().slice(0, 240),
      target: options.target ?? null,
    };
    postToChrome('planner:queuePrompt', { prompt });
    removeAnnotationCard();
  });

  shadow.getElementById('cancelBtn').addEventListener('click', removeAnnotationCard);
}

function removeAnnotationCard() {
  if (cardHost) { cardHost.remove(); cardHost = null; }
  currentTarget = null;
}
```

### Annotation mode

```js
let annotationMode = false;
let hoveredEl = null;

const INTERACTIVE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'LABEL', 'SUMMARY']);

function isInteractive(el) {
  return INTERACTIVE.has(el.tagName) || el.isContentEditable;
}

function setAnnotationMode(enabled) {
  annotationMode = enabled;
  document.body.style.cursor = enabled ? 'default' : '';
  if (!enabled) {
    clearHover();
    removeAnnotationCard();
  }
}

function clearHover() {
  if (hoveredEl) {
    hoveredEl.style.outline = '';
    hoveredEl.style.outlineOffset = '';
    hoveredEl = null;
  }
}

document.addEventListener('mouseover', (e) => {
  if (!annotationMode) return;
  clearHover();
  const el = e.target;
  if (!el || el === document.documentElement || isInteractive(el)) return;
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '2px';
  hoveredEl = el;
}, true);

document.addEventListener('mouseout', () => {
  if (!annotationMode) return;
  clearHover();
}, true);

document.addEventListener('click', (e) => {
  if (!annotationMode) return;
  const el = e.target;
  if (!el || isInteractive(el)) return;
  e.preventDefault();
  e.stopPropagation();
  showAnnotationCard(el);
}, true);

// Text selection annotation
document.addEventListener('mouseup', (e) => {
  if (!annotationMode) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const text = selection.toString().trim();
  if (!text) return;
  const range = selection.getRangeAt(0);
  const el = range.commonAncestorContainer.nodeType === 3
    ? range.commonAncestorContainer.parentElement
    : range.commonAncestorContainer;
  showAnnotationCard(el, {
    isText: true,
    target: { type: 'text-range', text, selector: generateSelector(el) },
  });
});
```

### postMessage bridge

```js
function postToChrome(type, data) {
  window.parent.postMessage({ type, ...data }, '*');
}

window.addEventListener('message', (e) => {
  const { type } = e.data ?? {};

  if (type === 'planner:setAnnotationMode') {
    setAnnotationMode(!!e.data.enabled);
  }

  if (type === 'planner:requestSnapshot') {
    postToChrome('planner:snapshot', { snapshot: buildSnapshot() });
  }

  if (type === 'planner:restoreScroll') {
    window.scrollTo(e.data.x ?? 0, e.data.y ?? 0);
  }
});

window.addEventListener('scroll', () => {
  postToChrome('planner:scroll', { x: window.scrollX, y: window.scrollY });
}, { passive: true });
```

### `window.planner` public API

Lets plan HTML itself call planner programmatically:

```js
window.planner = {
  queuePrompt(prompt, options) {
    postToChrome('planner:queuePrompt', {
      prompt: {
        uid: String(Date.now()),
        prompt: String(prompt),
        tag: 'message',
        selector: '',
        text: '',
        target: null,
        ...options,
      },
    });
  },
  snapshot() {
    return buildSnapshot();
  },
};
```

---

## Verification

```sh
# 1. Open a plan with content
cat > /tmp/plan.html << 'EOF'
<!doctype html>
<html>
<body>
  <h1>My Plan</h1>
  <p>Step one: do the thing.</p>
  <p>Step two: do more things.</p>
</body>
</html>
EOF
node planner.mjs open /tmp/plan.html
```

**In browser:**
2. Plan iframe loads and shows "My Plan" heading (no longer 501)
3. Toggle "Annotate" on
4. Hover over `<h1>` — yellow outline appears
5. Click `<h1>` — annotation card appears with tag "h1"
6. Type "Make this bigger" → click Queue → pill appears in chrome panel
7. Click Send → pill clears

**In another terminal:**
```sh
node planner.mjs poll /tmp/plan.html
# → JSON with prompts: [{ prompt: "Make this bigger", selector: "h1", tag: "h1", ... }]
# → dom_snapshot contains uid tree
```

**Path traversal test:**
```sh
KEY=$(cat ~/.planner/state.json | node -e "const s=require('fs').readFileSync('/dev/stdin','utf8');console.log(Object.keys(JSON.parse(s).sessions)[0])")
curl -v "http://127.0.0.1:4737/plan/$KEY/../../etc/passwd"
# → 403 Forbidden
```

**Sibling asset test:**
```sh
echo "body { background: red; }" > /tmp/style.css
# Add <link rel="stylesheet" href="style.css"> to /tmp/plan.html
# Reload browser — red background loads correctly
```

All checks passing = Phase 4 complete. Proceed to Phase 5 (Layout audit).
