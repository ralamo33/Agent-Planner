# Phase 5 — Layout Audit

**Goal:** The SDK automatically detects layout issues (overflow, clipped text, overlapping elements) and reports them via `layout_warnings` in poll output. The chrome holds the plan behind a gate until errors are resolved.

**Prerequisite:** Phase 4 complete — SDK injected, annotations work.

**Files to modify:** `browser/sdk.js` (add audit block), `browser/chrome.js` (add layout gate)

---

## `browser/sdk.js` — add layout audit block

Add this as a new section at the bottom of the IIFE, before the init call. The audit runs once after the plan's geometry stabilizes.

### Timing sequence

```js
function runLayoutAuditWhenReady() {
  document.fonts.ready.then(() => {
    waitForResizeSettle(runLayoutAudit);
  });
}

function waitForResizeSettle(callback) {
  let timer = null;
  const deadline = Date.now() + 2000;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    if (Date.now() >= deadline) { ro.disconnect(); callback(); return; }
    timer = setTimeout(() => { ro.disconnect(); callback(); }, 180);
  });
  // Observe up to 800 elements
  const els = Array.from(document.querySelectorAll('*')).slice(0, 800);
  for (const el of els) ro.observe(el);
  // Fallback if nothing ever resizes
  timer = setTimeout(() => { ro.disconnect(); callback(); }, 2000);
}

function runLayoutAudit() {
  // Two RAF ticks to let layout paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const findings = collectFindings();
    postToChrome('planner:layoutWarnings', { layout_warnings: findings });
    // Also POST directly to server so poll can return them
    fetch(`/api/${key}/layout-warnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout_warnings: findings }),
    }).catch(() => {});
  }));
}
```

**Note:** The SDK posts layout warnings both via `postMessage` (to update the chrome gate in real time) and via `fetch` (to persist them for the next poll). The `fetch` works because `allow-forms` is in the sandbox — but `fetch` also works without it in modern browsers. Use `fetch` here.

### `collectFindings()`

```js
function collectFindings() {
  const findings = [];
  const vw = window.innerWidth;

  // 1. Page horizontal overflow
  const pageOverflow = document.documentElement.scrollWidth - vw;
  if (pageOverflow > 1) {
    findings.push({
      selector: 'html',
      kind: 'page-horizontal-overflow',
      overflowPx: round(pageOverflow),
      viewportWidth: vw,
      severity: pageOverflow > 4 ? 'error' : 'warning',
    });
  }

  // Walk all elements for per-element checks
  const allEls = Array.from(document.querySelectorAll('*'));
  const textEls = []; // leaf text elements for overlap check

  for (const el of allEls) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    // 2. Element scroll overflow (horizontal)
    const hOverflow = el.scrollWidth - el.clientWidth;
    if (hOverflow > 1) {
      const clipsH = (style.overflowX === 'hidden' || style.overflowX === 'clip')
        && hasReadableText(el)
        && !isIntentionalTruncation(style);
      findings.push({
        selector: generateSelector(el),
        kind: clipsH ? 'clipped-text' : 'element-scroll-overflow',
        overflowPx: round(hOverflow),
        viewportWidth: vw,
        severity: clipsH ? 'error' : (hOverflow > 4 ? 'error' : 'warning'),
      });
    }

    // 3. Element scroll overflow (vertical clipping)
    const vOverflow = el.scrollHeight - el.clientHeight;
    if (vOverflow > 1
      && (style.overflowY === 'hidden' || style.overflowY === 'clip')
      && hasReadableText(el)
      && !isIntentionalTruncation(style)) {
      findings.push({
        selector: generateSelector(el),
        kind: 'clipped-text',
        overflowPx: round(vOverflow),
        viewportWidth: vw,
        severity: 'error',
      });
    }

    // 4. Element overflowing parent bounds
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
      const parentStyle = getComputedStyle(parent);
      const parentRect = contentBoxRect(parent);
      const rightOverflow = rect.right - parentRect.right;
      if (rightOverflow > 1 && rect.width > 1) {
        const positioned = ['absolute', 'fixed', 'sticky'].includes(style.position);
        findings.push({
          selector: generateSelector(el),
          kind: 'element-parent-overflow',
          overflowPx: round(rightOverflow),
          viewportWidth: vw,
          severity: positioned ? 'warning' : (rightOverflow > 4 ? 'error' : 'warning'),
        });
      }
    }

    // Collect leaf text elements for overlap check
    if (el.children.length === 0 && hasReadableText(el)) {
      textEls.push(el);
    }
  }

  // 5. Overlapping text (up to 200 leaf text elements)
  for (const el of textEls.slice(0, 200)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    // Check center + two corners
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 4, rect.top + 4],
      [rect.right - 4, rect.bottom - 4],
    ];
    for (const [x, y] of points) {
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || isAncestorOrDescendant(top, el)) continue;
      const topStyle = getComputedStyle(top);
      if (getComputedStyle(el).position !== 'static' || topStyle.position !== 'static') continue;
      findings.push({
        selector: generateSelector(el),
        kind: 'overlapping-text',
        overflowPx: 0,
        viewportWidth: vw,
        severity: 'error',
      });
      break;
    }
  }

  return findings;
}
```

### Helper functions

```js
function round(n) { return Math.round(n * 10) / 10; }

function hasReadableText(el) {
  const text = (el.textContent ?? '').trim();
  return text.length > 0;
}

function isIntentionalTruncation(style) {
  return style.textOverflow === 'ellipsis'
    || style.webkitLineClamp !== 'none'
    || style.webkitBoxOrient === 'vertical';
}

function contentBoxRect(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const pl = parseFloat(style.paddingLeft) || 0;
  const pr = parseFloat(style.paddingRight) || 0;
  const pt = parseFloat(style.paddingTop) || 0;
  const pb = parseFloat(style.paddingBottom) || 0;
  const bl = parseFloat(style.borderLeftWidth) || 0;
  const br = parseFloat(style.borderRightWidth) || 0;
  const bt = parseFloat(style.borderTopWidth) || 0;
  const bb = parseFloat(style.borderBottomWidth) || 0;
  return {
    left: rect.left + pl + bl,
    right: rect.right - pr - br,
    top: rect.top + pt + bt,
    bottom: rect.bottom - pb - bb,
  };
}

function isAncestorOrDescendant(a, b) {
  return a.contains(b) || b.contains(a);
}
```

### Deduplicate re-runs

Avoid spamming the server with identical findings on every resize. Track the last-sent signature:

```js
let lastAuditSignature = null;

function runLayoutAudit() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const findings = collectFindings();
    const sig = JSON.stringify(findings);
    if (sig === lastAuditSignature) return;
    lastAuditSignature = sig;
    postToChrome('planner:layoutWarnings', { layout_warnings: findings });
    fetch(`/api/${key}/layout-warnings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout_warnings: findings }),
    }).catch(() => {});
  }));
}
```

### Wire up in init

At the bottom of the IIFE, after all functions are defined:

```js
// Start layout audit
runLayoutAuditWhenReady();
```

---

## `browser/chrome.js` — add layout gate

### State and DOM elements

Add to chrome.js startup:

```js
let layoutErrors = 0;
let layoutGateTimeout = null;
let layoutGateRevealed = false;
```

Add to the chrome HTML (inside `.frame`, after `<iframe>`):

```html
<div class="layout-gate" id="layoutGate">
  <div class="layout-gate-box">
    <div class="layout-gate-spinner"></div>
    <p id="layoutGateMsg">Checking layout…</p>
    <button id="layoutGateBypass" hidden>Show anyway</button>
  </div>
</div>
```

Add to `createChromeHtml()` in `planner.mjs` inside `.frame`:

```html
<div class="layout-gate" id="layoutGate">
  <div class="layout-gate-box">
    <p id="layoutGateMsg">Checking layout…</p>
    <button id="layoutGateBypass" hidden>Show anyway</button>
  </div>
</div>
```

### Gate logic in chrome.js

```js
const layoutGate = document.getElementById('layoutGate');
const layoutGateMsg = document.getElementById('layoutGateMsg');
const layoutGateBypass = document.getElementById('layoutGateBypass');

// Start gate timer on each iframe load
frame.addEventListener('load', () => {
  // ... existing load handler code ...
  startLayoutGate();
});

function startLayoutGate() {
  if (layoutGateRevealed) { revealGate(); return; } // already bypassed this session
  layoutGate.hidden = false;
  layoutGateMsg.textContent = 'Checking layout…';
  layoutGateBypass.hidden = true;
  layoutErrors = 0;
  clearTimeout(layoutGateTimeout);
  // Auto-reveal after 12s regardless
  layoutGateTimeout = setTimeout(() => {
    revealGate();
    if (layoutErrors > 0) {
      appendChatBubble({ role: 'agent', text: `⚠️ Plan may have layout issues (${layoutErrors} error${layoutErrors > 1 ? 's' : ''} found). Review before sending feedback.` });
    }
  }, 12_000);
}

function revealGate() {
  clearTimeout(layoutGateTimeout);
  layoutGate.hidden = true;
  layoutGateRevealed = true;
}

layoutGateBypass.addEventListener('click', revealGate);
```

### Handle `planner:layoutWarnings` from iframe

Update the `window.addEventListener('message', ...)` handler in chrome.js:

```js
if (type === 'planner:layoutWarnings') {
  const warnings = e.data.layout_warnings ?? [];
  const errors = warnings.filter(w => w.severity === 'error');
  layoutErrors = errors.length;

  if (errors.length === 0) {
    // Clean — reveal gate
    revealGate();
  } else {
    // Errors — hold gate, update message, show bypass
    layoutGateMsg.textContent = `Fixing ${errors.length} layout issue${errors.length > 1 ? 's' : ''}…`;
    layoutGateBypass.hidden = false;
  }
}
```

### CSS for the gate (add to `chrome.css`)

```css
.layout-gate {
  position: absolute;
  inset: 0;
  background: rgba(255,255,255,0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.layout-gate[hidden] { display: none; }
.layout-gate-box {
  text-align: center;
  padding: 24px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 16px rgba(0,0,0,.1);
  font-size: 14px;
  color: #444;
}
.layout-gate-box p { margin-bottom: 12px; }
.layout-gate-box button {
  padding: 6px 16px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.layout-gate-box button:hover { background: #f5f5f5; }
```

---

## `next_step` wording update in `planner.mjs`

When poll returns layout warnings with errors, the `next_step` in the CLI output should prioritize fixing them. Update `buildNextStep` in `planner.mjs` (already drafted in Phase 2 plan):

```js
function buildNextStep(file, result) {
  if (result.status === 'ended') return 'Session ended.';
  if (result.status === 'waiting') return `No feedback yet. Re-run \`node planner.mjs poll ${file}\`.`;
  const errors = (result.layout_warnings ?? []).filter(w => w.severity === 'error');
  if (errors.length > 0) {
    return `Fix ${errors.length} layout error(s) in ${file} before asking for human feedback: ${errors.map(w => w.kind).join(', ')}. Then re-run poll.`;
  }
  return `Apply feedback to ${file}, then run \`node planner.mjs poll ${file} --agent-reply "what you changed"\`.`;
}
```

---

## Verification

```sh
# 1. Overflow triggers layout_warnings in poll
cat > /tmp/overflow.html << 'EOF'
<!doctype html>
<html>
<body>
  <div style="width:2000px;background:red;height:40px">This overflows</div>
  <p>Normal content</p>
</body>
</html>
EOF

node planner.mjs open /tmp/overflow.html
node planner.mjs poll /tmp/overflow.html
# → layout_warnings contains page-horizontal-overflow with severity: "error"
# → next_step says to fix layout errors first
```

**In browser:**
2. Chrome gate shows "Checking layout…" on load
3. Gate switches to "Fixing 1 layout issue…" when SDK reports error
4. "Show anyway" button appears
5. Click "Show anyway" — gate dismisses, plan visible

```sh
# 6. Fix the overflow, re-open
cat > /tmp/overflow.html << 'EOF'
<!doctype html>
<html>
<body>
  <div style="width:100%;background:red;height:40px">Fixed</div>
  <p>Normal content</p>
</body>
</html>
EOF

node planner.mjs poll /tmp/overflow.html --agent-reply "Fixed the overflow"
# → Browser shows agent reply bubble
# → Gate checks layout again on iframe reload, reveals immediately (no errors)
```

```sh
# 7. Clipped text check
cat > /tmp/clipped.html << 'EOF'
<!doctype html>
<html>
<body>
  <div style="width:100px;height:20px;overflow:hidden">
    This text is way too long and gets clipped by the container
  </div>
</body>
</html>
EOF
node planner.mjs open /tmp/clipped.html
node planner.mjs poll /tmp/clipped.html
# → layout_warnings contains clipped-text with severity: "error"
```

All checks passing = Phase 5 complete. All phases done — full planner tool working.
