(function () {
  var scriptEl = document.currentScript;
  var key = scriptEl ? new URL(scriptEl.src, location.href).searchParams.get('key') : null;
  if (!key) return;

  // ── UID tracking ──────────────────────────────────────────────────────────
  var uidMap = new WeakMap();
  var uidCounter = 0;

  function uid(el) {
    if (!uidMap.has(el)) uidMap.set(el, ++uidCounter);
    return String(uidMap.get(el));
  }

  // ── Selector generation ───────────────────────────────────────────────────
  function generateSelector(el) {
    var parts = [];
    var node = el;
    for (var i = 0; i < 6 && node && node !== document.documentElement; i++) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var part = node.tagName.toLowerCase();
      if (node.className && typeof node.className === 'string') {
        var cls = node.className.trim().split(/\s+/).slice(0, 2).map(function (c) { return '.' + CSS.escape(c); }).join('');
        part += cls;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // ── DOM snapshot ──────────────────────────────────────────────────────────
  function buildSnapshot(root, depth) {
    root = root || document.body;
    depth = depth || 0;
    if (!root) return '';
    var lines = [];
    for (var i = 0; i < root.children.length; i++) {
      var child = root.children[i];
      var tag = child.tagName.toLowerCase();
      var text = ((child.innerText || '').trim()).slice(0, 80).replace(/\n/g, ' ');
      var indent = new Array(depth + 1).join('  ');
      lines.push(indent + 'uid=' + uid(child) + ' ' + tag + (text ? ' "' + text + '"' : ''));
      if (child.children.length && depth < 5) {
        var sub = buildSnapshot(child, depth + 1);
        if (sub) lines.push(sub);
      }
    }
    return lines.join('\n');
  }

  // ── postMessage bridge ────────────────────────────────────────────────────
  function postToChrome(type, data) {
    var msg = Object.assign({ type: type }, data);
    window.parent.postMessage(msg, '*');
  }

  // ── Annotation card (Shadow DOM) ──────────────────────────────────────────
  var cardHost = null;

  function showAnnotationCard(el, options) {
    options = options || {};
    removeAnnotationCard();
    cardHost = document.createElement('div');
    cardHost.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
    document.documentElement.appendChild(cardHost);

    var shadow = cardHost.attachShadow({ mode: 'open' });
    var rect = el.getBoundingClientRect();
    var top = Math.min(rect.bottom + 8, window.innerHeight - 220);
    var left = Math.min(rect.left, window.innerWidth - 280);

    shadow.innerHTML = '<style>'
      + '.card{position:fixed;background:#fff;border:1px solid #ddd;border-radius:10px;'
      + 'box-shadow:0 4px 20px rgba(0,0,0,.15);padding:12px;width:260px;'
      + 'pointer-events:all;font-family:system-ui,sans-serif;font-size:13px;}'
      + '.meta{color:#888;margin-bottom:8px;font-size:11px;}'
      + 'textarea{width:100%;border:1px solid #ddd;border-radius:6px;padding:6px;'
      + 'font-size:13px;font-family:inherit;resize:none;margin-bottom:8px;}'
      + 'textarea:focus{outline:none;border-color:#1a73e8;}'
      + '.row{display:flex;gap:6px;}'
      + 'button{flex:1;padding:6px;border:none;border-radius:6px;cursor:pointer;font-size:12px;}'
      + '.queue{background:#1a73e8;color:#fff;font-weight:500;}'
      + '.cancel{background:#f5f5f5;color:#444;}'
      + '</style>'
      + '<div class="card" style="top:' + top + 'px;left:' + left + 'px">'
      + '<div class="meta">' + el.tagName.toLowerCase() + (options.isText ? ' · text selection' : '') + '</div>'
      + '<textarea id="noteInput" placeholder="Add a note…" rows="3"></textarea>'
      + '<div class="row"><button class="queue" id="queueBtn">Queue</button><button class="cancel" id="cancelBtn">Cancel</button></div>'
      + '</div>';

    var noteInput = shadow.getElementById('noteInput');
    noteInput.focus();

    shadow.getElementById('queueBtn').addEventListener('click', function () {
      var note = noteInput.value.trim();
      if (note) {
        var prompt = {
          uid: uid(el),
          prompt: note,
          selector: generateSelector(el),
          tag: options.isText ? 'text' : el.tagName.toLowerCase(),
          text: ((el.innerText || '').trim()).slice(0, 240),
          target: options.target || null,
        };
        postToChrome('planner:queuePrompt', { prompt: prompt });
      }
      removeAnnotationCard();
    });

    shadow.getElementById('cancelBtn').addEventListener('click', removeAnnotationCard);
  }

  function removeAnnotationCard() {
    if (cardHost) { cardHost.remove(); cardHost = null; }
  }

  // ── Annotation mode ───────────────────────────────────────────────────────
  var annotationMode = false;
  var hoveredEl = null;
  var INTERACTIVE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'LABEL', 'SUMMARY']);

  function isInteractive(el) {
    return INTERACTIVE.has(el.tagName) || el.isContentEditable;
  }

  function setAnnotationMode(enabled) {
    annotationMode = enabled;
    document.body.style.cursor = enabled ? 'default' : '';
    if (!enabled) { clearHover(); removeAnnotationCard(); }
  }

  function clearHover() {
    if (hoveredEl) {
      hoveredEl.style.outline = '';
      hoveredEl.style.outlineOffset = '';
      hoveredEl = null;
    }
  }

  document.addEventListener('mouseover', function (e) {
    if (!annotationMode) return;
    clearHover();
    var el = e.target;
    if (!el || el === document.documentElement || isInteractive(el)) return;
    el.style.outline = '2px solid #f59e0b';
    el.style.outlineOffset = '2px';
    hoveredEl = el;
  }, true);

  document.addEventListener('mouseout', function () {
    if (!annotationMode) return;
    clearHover();
  }, true);

  document.addEventListener('click', function (e) {
    if (!annotationMode) return;
    if (cardHost && e.composedPath().includes(cardHost)) return;
    var el = e.target;
    if (!el || isInteractive(el)) return;
    e.preventDefault();
    e.stopPropagation();
    showAnnotationCard(el);
  }, true);

  document.addEventListener('mouseup', function () {
    if (!annotationMode) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    var text = selection.toString().trim();
    if (!text) return;
    var range = selection.getRangeAt(0);
    var el = range.commonAncestorContainer.nodeType === 3
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    showAnnotationCard(el, {
      isText: true,
      target: { type: 'text-range', text: text, selector: generateSelector(el) },
    });
  });

  // ── Scroll tracking ───────────────────────────────────────────────────────
  window.addEventListener('scroll', function () {
    postToChrome('planner:scroll', { x: window.scrollX, y: window.scrollY });
  }, { passive: true });

  // ── postMessage from chrome ───────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    var type = e.data.type;
    if (type === 'planner:setAnnotationMode') setAnnotationMode(!!e.data.enabled);
    if (type === 'planner:requestSnapshot') postToChrome('planner:snapshot', { snapshot: buildSnapshot() });
    if (type === 'planner:restoreScroll') window.scrollTo(e.data.x || 0, e.data.y || 0);
  });

  // ── Layout audit ──────────────────────────────────────────────────────────
  var lastAuditSignature = null;

  function round(n) { return Math.round(n * 10) / 10; }

  function hasReadableText(el) {
    return ((el.textContent || '').trim()).length > 0;
  }

  function isIntentionalTruncation(style) {
    return style.textOverflow === 'ellipsis'
      || style.webkitLineClamp !== 'none'
      || style.webkitBoxOrient === 'vertical';
  }

  function contentBoxRect(el) {
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    return {
      left: rect.left + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0),
      right: rect.right - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0),
      top: rect.top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0),
      bottom: rect.bottom - (parseFloat(style.paddingBottom) || 0) - (parseFloat(style.borderBottomWidth) || 0),
    };
  }

  function isAncestorOrDescendant(a, b) {
    return a.contains(b) || b.contains(a);
  }

  function collectFindings() {
    var findings = [];
    var vw = window.innerWidth;

    var pageOverflow = document.documentElement.scrollWidth - vw;
    if (pageOverflow > 1) {
      findings.push({
        selector: 'html',
        kind: 'page-horizontal-overflow',
        overflowPx: round(pageOverflow),
        viewportWidth: vw,
        severity: pageOverflow > 4 ? 'error' : 'warning',
      });
    }

    var allEls = Array.from(document.querySelectorAll('*'));
    var textEls = [];

    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (el === document.documentElement || el === document.body) continue;
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      var hOverflow = el.scrollWidth - el.clientWidth;
      if (hOverflow > 1) {
        var clipsH = (style.overflowX === 'hidden' || style.overflowX === 'clip')
          && hasReadableText(el) && !isIntentionalTruncation(style);
        findings.push({
          selector: generateSelector(el),
          kind: clipsH ? 'clipped-text' : 'element-scroll-overflow',
          overflowPx: round(hOverflow),
          viewportWidth: vw,
          severity: clipsH ? 'error' : (hOverflow > 4 ? 'error' : 'warning'),
        });
      }

      var vOverflow = el.scrollHeight - el.clientHeight;
      if (vOverflow > 1
        && (style.overflowY === 'hidden' || style.overflowY === 'clip')
        && hasReadableText(el) && !isIntentionalTruncation(style)) {
        findings.push({
          selector: generateSelector(el),
          kind: 'clipped-text',
          overflowPx: round(vOverflow),
          viewportWidth: vw,
          severity: 'error',
        });
      }

      var parent = el.parentElement;
      if (parent && parent !== document.documentElement) {
        var parentRect = contentBoxRect(parent);
        var rightOverflow = rect.right - parentRect.right;
        if (rightOverflow > 1 && rect.width > 1) {
          var positioned = style.position === 'absolute' || style.position === 'fixed' || style.position === 'sticky';
          findings.push({
            selector: generateSelector(el),
            kind: 'element-parent-overflow',
            overflowPx: round(rightOverflow),
            viewportWidth: vw,
            severity: positioned ? 'warning' : (rightOverflow > 4 ? 'error' : 'warning'),
          });
        }
      }

      if (el.children.length === 0 && hasReadableText(el)) textEls.push(el);
    }

    var sample = textEls.slice(0, 200);
    for (var j = 0; j < sample.length; j++) {
      var el2 = sample[j];
      var r = el2.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      var points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 4, r.top + 4],
        [r.right - 4, r.bottom - 4],
      ];
      var found = false;
      for (var k = 0; k < points.length && !found; k++) {
        var top = document.elementFromPoint(points[k][0], points[k][1]);
        if (!top || top === el2 || isAncestorOrDescendant(top, el2)) continue;
        if (getComputedStyle(el2).position !== 'static' || getComputedStyle(top).position !== 'static') continue;
        findings.push({ selector: generateSelector(el2), kind: 'overlapping-text', overflowPx: 0, viewportWidth: vw, severity: 'error' });
        found = true;
      }
    }

    return findings;
  }

  function runLayoutAudit() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var findings = collectFindings();
        var sig = JSON.stringify(findings);
        if (sig === lastAuditSignature) return;
        lastAuditSignature = sig;
        postToChrome('planner:layoutWarnings', { layout_warnings: findings });
      });
    });
  }

  function waitForResizeSettle(callback) {
    var timer = null;
    var deadline = Date.now() + 2000;
    var ro = new ResizeObserver(function () {
      clearTimeout(timer);
      if (Date.now() >= deadline) { ro.disconnect(); callback(); return; }
      timer = setTimeout(function () { ro.disconnect(); callback(); }, 180);
    });
    var els = Array.from(document.querySelectorAll('*')).slice(0, 800);
    for (var i = 0; i < els.length; i++) ro.observe(els[i]);
    timer = setTimeout(function () { ro.disconnect(); callback(); }, 2000);
  }

  function runLayoutAuditWhenReady() {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { waitForResizeSettle(runLayoutAudit); });
    } else {
      waitForResizeSettle(runLayoutAudit);
    }
  }

  // ── window.planner public API ─────────────────────────────────────────────
  window.planner = {
    queuePrompt: function (prompt, options) {
      postToChrome('planner:queuePrompt', {
        prompt: Object.assign({
          uid: String(Date.now()),
          prompt: String(prompt),
          tag: 'message',
          selector: '',
          text: '',
          target: null,
        }, options),
      });
    },
    snapshot: function () { return buildSnapshot(); },
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  runLayoutAuditWhenReady();
})();
