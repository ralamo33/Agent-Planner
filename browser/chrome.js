(function () {
  const session = JSON.parse(document.getElementById('planner-session').textContent);
  const { key, name, initialChat } = session;

  const frame = document.getElementById('planFrame');
  const chatLog = document.getElementById('chatLog');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const endBtn = document.getElementById('endBtn');
  const presenceBanner = document.getElementById('presenceBanner');
  const annotateToggle = document.getElementById('annotateToggle');
  const annotationPills = document.getElementById('annotationPills');
  const endedOverlay = document.getElementById('endedOverlay');
  const layoutGate = document.getElementById('layoutGate');
  const layoutGateMsg = document.getElementById('layoutGateMsg');
  const layoutGateBypass = document.getElementById('layoutGateBypass');

  let queued = JSON.parse(sessionStorage.getItem('planner:queued:' + key) ?? '[]');
  let agentPresence = 'waiting';
  let ended = false;
  let snapshotResolve = null;
  let layoutErrors = 0;
  let layoutGateTimeout = null;
  let layoutGateRevealed = false;

  annotateToggle.checked = true;
  frame.src = frame.dataset.planSrc;
  renderChat(initialChat);
  connectSse();
  renderPills();
  updateSendButton();

  function renderChat(messages) {
    chatLog.innerHTML = '';
    for (const msg of messages) appendChatBubble(msg);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendChatBubble(msg) {
    const div = document.createElement('div');
    div.className = 'bubble bubble-' + msg.role;
    div.textContent = msg.text;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function connectSse() {
    const es = new EventSource('/events/' + key);
    es.addEventListener('chat-sync', e => { renderChat(JSON.parse(e.data).chat); });
    es.addEventListener('agent-presence', e => { setPresence(JSON.parse(e.data).state); });
    es.addEventListener('agent-reply', e => { appendChatBubble({ role: 'agent', text: JSON.parse(e.data).text }); });
    es.addEventListener('reload', () => { frame.src = frame.dataset.planSrc; });
    es.addEventListener('chrome-reload', () => { location.reload(); });
    es.onerror = () => { es.close(); setTimeout(connectSse, 2000); };
  }

  function setPresence(state) {
    agentPresence = state;
    presenceBanner.hidden = state !== 'waiting' && state !== 'working';
    presenceBanner.textContent = state === 'waiting' ? 'Agent is not listening yet'
      : state === 'working' ? 'Agent is working…' : '';
    updateSendButton();
  }

  function updateSendButton() {
    sendBtn.disabled = ended || agentPresence === 'working' || (queued.length === 0 && !chatInput.value.trim());
  }

  function persistQueue() {
    sessionStorage.setItem('planner:queued:' + key, JSON.stringify(queued));
  }

  function enqueuePrompt(prompt) {
    const queueKey = (prompt._plannerQueueKey ?? '').trim();
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
      pill.textContent = p.selector || p.tag || 'note';
      pill.title = p.prompt;
      annotationPills.appendChild(pill);
    }
    updateSendButton();
  }

  async function submit() {
    if (sendBtn.disabled) return;
    const text = chatInput.value.trim();
    const allPrompts = [...queued];
    if (text) {
      allPrompts.push({ uid: String(Date.now()), prompt: text, tag: 'message', selector: '', text: '' });
    }
    if (allPrompts.length === 0) return;

    let snapshot = '';
    try { snapshot = await requestSnapshot(); } catch {}

    const clean = allPrompts.map(p => {
      const copy = Object.assign({}, p);
      delete copy._plannerQueueKey;
      return copy;
    });

    try {
      const res = await fetch('/api/' + key + '/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: clean, dom_snapshot: snapshot }),
      });
      if (res.ok) {
        queued = [];
        persistQueue();
        chatInput.value = '';
        renderPills();
        updateSendButton();
      }
    } catch (err) {
      console.error('[planner] submit failed', err);
    }
  }

  function requestSnapshot() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { snapshotResolve = null; reject(new Error('snapshot timeout')); }, 3000);
      snapshotResolve = (snapshot) => { clearTimeout(timeout); snapshotResolve = null; resolve(snapshot); };
      postToFrame({ type: 'planner:requestSnapshot' });
    });
  }

  function postToFrame(msg) {
    frame.contentWindow && frame.contentWindow.postMessage(msg, '*');
  }

  function startLayoutGate() {
    if (layoutGateRevealed) return;
    layoutGate.hidden = false;
    layoutGateMsg.textContent = 'Checking layout…';
    layoutGateBypass.hidden = true;
    layoutErrors = 0;
    clearTimeout(layoutGateTimeout);
    layoutGateTimeout = setTimeout(function () {
      revealGate();
      if (layoutErrors > 0) {
        appendChatBubble({ role: 'agent', text: '⚠️ Plan may have layout issues (' + layoutErrors + ' error' + (layoutErrors > 1 ? 's' : '') + ' found). Review before sending feedback.' });
      }
    }, 12000);
  }

  function revealGate() {
    clearTimeout(layoutGateTimeout);
    layoutGate.hidden = true;
    layoutGateRevealed = true;
  }

  layoutGateBypass.addEventListener('click', revealGate);

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    const type = e.data.type;

    if (type === 'planner:queuePrompt') {
      enqueuePrompt(e.data.prompt);
    }
    if (type === 'planner:snapshot') {
      if (snapshotResolve) snapshotResolve(e.data.snapshot ?? '');
    }
    if (type === 'planner:scroll') {
      try { sessionStorage.setItem('planner:scroll:' + key, JSON.stringify({ x: e.data.x, y: e.data.y })); } catch {}
    }
    if (type === 'planner:layoutWarnings') {
      const warnings = e.data.layout_warnings ?? [];
      const errors = warnings.filter(function (w) { return w.severity === 'error'; });
      layoutErrors = errors.length;
      if (errors.length === 0) {
        revealGate();
      } else {
        layoutGateMsg.textContent = 'Fixing ' + errors.length + ' layout issue' + (errors.length > 1 ? 's' : '') + '…';
        layoutGateBypass.hidden = false;
      }
      fetch('/api/' + key + '/layout-warnings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout_warnings: warnings }),
      }).catch(function () {});
    }
  });

  sendBtn.addEventListener('click', submit);
  chatInput.addEventListener('input', updateSendButton);
  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });

  annotateToggle.addEventListener('change', function () {
    postToFrame({ type: 'planner:setAnnotationMode', enabled: annotateToggle.checked });
  });

  endBtn.addEventListener('click', async function () {
    if (!confirm('End this session? The plan will be archived.')) return;
    await fetch('/api/plans/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    ended = true;
    endedOverlay.hidden = false;
    updateSendButton();
  });

  frame.addEventListener('load', function () {
    layoutGateRevealed = false;
    startLayoutGate();
    postToFrame({ type: 'planner:setAnnotationMode', enabled: annotateToggle.checked });
    try {
      const saved = sessionStorage.getItem('planner:scroll:' + key);
      if (saved) {
        const pos = JSON.parse(saved);
        postToFrame({ type: 'planner:restoreScroll', x: pos.x, y: pos.y });
      }
    } catch {}
  });
})();
