// app.js — overlay UI logic
(() => {
  const V = window.veliance;
  const $ = id => document.getElementById(id);

  const el = {
    stage: $('stage'), bar: $('bar'), grip: $('grip'),
    btnListen: $('btnListen'), btnAsk: $('btnAsk'), btnShot: $('btnShot'),
    btnHide: $('btnHide'), btnSettings: $('btnSettings'), status: $('status'),
    panel: $('panel'), thread: $('thread'), input: $('input'),
    btnSend: $('btnSend'), btnStop: $('btnStop'),
    shotChip: $('shotChip'), shotRemove: $('shotRemove'),
    transcriptStrip: $('transcriptStrip'), transcript: $('transcript'), tSource: $('tSource'),
    btnAnswer: $('btnAnswer'), btnClearT: $('btnClearT'),
    settings: $('settings'), btnCloseSettings: $('btnCloseSettings'), encBadge: $('encBadge'),
    providerSeg: $('providerSeg'), audioSeg: $('audioSeg'),
    anthKey: $('anthKey'), anthSave: $('anthSave'), anthTest: $('anthTest'), anthState: $('anthState'), anthModel: $('anthModel'),
    oaiKey: $('oaiKey'), oaiSave: $('oaiSave'), oaiTest: $('oaiTest'), oaiState: $('oaiState'), oaiModel: $('oaiModel'), trModel: $('trModel'),
    permHint: $('permHint'), opacity: $('opacity'), opacityVal: $('opacityVal'), sysPrompt: $('sysPrompt'),
    hotkeyList: $('hotkeyList'), hkReset: $('hkReset'), hkMsg: $('hkMsg'), btnQuit: $('btnQuit'),
    verState: $('verState'), btnCheckUpdate: $('btnCheckUpdate'), updMsg: $('updMsg'), btnGetUpdate: $('btnGetUpdate'),
    mpBtn: $('mpBtn'), mpProv: $('mpProv'), mpLabel: $('mpLabel'), mpMenu: $('mpMenu')
  };

  // ---------- state ----------
  let settings = null;
  const history = [];            // {role, text, imageBase64?}
  let pendingShot = null;        // base64 png waiting to be attached
  let streaming = null;          // {id, node, text}
  let listening = false;
  let transcriptText = '';
  let mediaStream = null;
  let recorder = null;
  let chunkTimer = null;
  let lastSeg = '';

  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- status line ----------
  let statusTimer = null;
  function status(text, kind = '', ms = 0) {
    el.status.textContent = text || '';
    el.status.className = 'status' + (kind ? ' ' + kind : '');
    clearTimeout(statusTimer);
    if (ms) statusTimer = setTimeout(() => status(''), ms);
  }

  // ---------- click-through management ----------
  // The window is pass-through by default — main launches it with
  // setIgnoreMouseEvents(true, { forward:true }), so clicks fall through to
  // whatever sits behind the overlay. We flip it interactive only while the
  // pointer is over the UI (.hit regions) OR while a text field is focused, so
  // the composer stays usable: the caret lands when you click in, and your
  // keystrokes are never dropped if the pointer wanders off the panel.
  let ignoring = true;
  function setIgnore(v) {
    if (v === ignoring) return;
    ignoring = v;
    V.window.setIgnoreMouse(v);
  }
  const overHit = t => !!(t && t.closest && t.closest('.hit'));
  const editing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable);
  };
  // Interactive whenever the pointer is on the UI or a field has focus; otherwise pass-through.
  const refreshIgnore = target => setIgnore(!(overHit(target) || editing()));

  document.addEventListener('mousemove', e => refreshIgnore(e.target));
  document.addEventListener('mouseleave', () => refreshIgnore(null));
  // Clicking into a field must hold the window interactive so the caret lands
  // and typing works; leaving the field hands pass-through back.
  document.addEventListener('focusin', () => { if (editing()) setIgnore(false); });
  document.addEventListener('focusout', () => setTimeout(() => refreshIgnore(null), 0));
  // If the overlay loses focus entirely, return to pass-through.
  window.addEventListener('blur', () => setIgnore(true));
  // Start interactive so the very first hover registers correctly
  setIgnore(false); setIgnore(true);

  // ---------- drag ----------
  (() => {
    let dragging = false, lx = 0, ly = 0;
    el.grip.addEventListener('mousedown', e => {
      dragging = true; lx = e.screenX; ly = e.screenY; e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.screenX - lx, dy = e.screenY - ly;
      if (dx || dy) { V.window.dragBy(dx, dy); lx = e.screenX; ly = e.screenY; }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; V.window.dragEnd();
    });
  })();

  // ---------- panels ----------
  function showPanel() {
    el.settings.classList.add('hidden');
    el.panel.classList.remove('hidden');
  }
  function hidePanelIfEmpty() {
    if (!history.length && !listening && !el.input.value && !pendingShot) el.panel.classList.add('hidden');
  }
  function openSettings() {
    el.panel.classList.add('hidden');
    el.settings.classList.remove('hidden');
    refreshSettingsUI();
  }
  function closeSettings() {
    el.settings.classList.add('hidden');
    if (history.length || listening) el.panel.classList.remove('hidden');
  }
  function focusInput() {
    showPanel();
    el.input.focus();
  }

  // ---------- markdown (small, safe) ----------
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext>$1</a>');
  }
  function md(src) {
    const lines = esc(src).split('\n');
    let out = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        let j = i + 1, code = [];
        while (j < lines.length && !/^```/.test(lines[j])) code.push(lines[j++]);
        out += `<pre><code>${code.join('\n')}</code></pre>`;
        i = j + 1; continue;
      }
      if (/^#{1,3}\s/.test(l)) { out += `<h3>${inline(l.replace(/^#{1,3}\s/, ''))}</h3>`; i++; continue; }
      if (/^>\s?/.test(l)) { out += `<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`; i++; continue; }
      if (/^\s*[-*•]\s+/.test(l)) {
        let items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>`), i++;
        out += `<ul>${items.join('')}</ul>`; continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        let items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`), i++;
        out += `<ol>${items.join('')}</ol>`; continue;
      }
      if (!l.trim()) { i++; continue; }
      let para = [l];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,3}\s|>\s?|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i + 1])) para.push(lines[++i]);
      out += `<p>${inline(para.join('<br>'))}</p>`; i++;
    }
    return out;
  }
  el.thread.addEventListener('click', e => {
    const a = e.target.closest('a[data-ext]');
    if (a) { e.preventDefault(); V.window.openExternal(a.getAttribute('href')); }
  });

  // ---------- thread rendering ----------
  function addUser(text, hasShot) {
    const n = document.createElement('div');
    n.className = 'msg user';
    if (hasShot) {
      const a = document.createElement('span');
      a.className = 'att'; a.textContent = '⌗ screen';
      n.appendChild(a);
    }
    n.appendChild(document.createTextNode(text));
    el.thread.appendChild(n);
    scrollThread();
  }
  function addAssistant() {
    const n = document.createElement('div');
    n.className = 'msg assistant streaming';
    el.thread.appendChild(n);
    scrollThread();
    return n;
  }
  function scrollThread() { el.thread.scrollTop = el.thread.scrollHeight; }

  function setBusy(b) {
    el.btnSend.classList.toggle('hidden', b);
    el.btnStop.classList.toggle('hidden', !b);
    status(b ? 'thinking…' : '', b ? 'busy' : '');
  }

  // ---------- sending ----------
  function buildContext() {
    // last 12 turns; only the newest user image is sent
    const recent = history.slice(-12);
    let imageSeen = false;
    return recent.slice().reverse().map(m => {
      const c = { role: m.role, text: m.text };
      if (m.imageBase64 && !imageSeen) { c.imageBase64 = m.imageBase64; imageSeen = true; }
      return c;
    }).reverse();
  }

  async function send(text, { image = null, silentUser = false, display = null } = {}) {
    text = (text || '').trim();
    if (!text && !image) return;
    if (streaming) await V.chat.abort();

    showPanel();
    history.push({ role: 'user', text: text || 'What is on my screen? If there is a question or problem visible, answer it directly.', imageBase64: image || undefined });
    if (!silentUser) addUser(display || text || 'What’s on my screen?', Boolean(image));

    const node = addAssistant();
    const id = uid();
    streaming = { id, node, text: '' };
    setBusy(true);
    V.chat.send(id, buildContext());
  }

  V.chat.onDelta(({ id, delta }) => {
    if (!streaming || streaming.id !== id) return;
    streaming.text += delta;
    streaming.node.innerHTML = md(streaming.text);
    scrollThread();
  });
  V.chat.onDone(({ id, text, aborted }) => {
    if (!streaming || streaming.id !== id) return;
    const s = streaming; streaming = null;
    s.node.classList.remove('streaming');
    const final = text ?? s.text;
    s.node.innerHTML = md(final || (aborted ? '_stopped_' : ''));
    if (final) history.push({ role: 'assistant', text: final });
    else if (aborted && s.text) history.push({ role: 'assistant', text: s.text });
    else if (!final) { s.node.remove(); history.pop(); }
    setBusy(false);
    scrollThread();
  });
  V.chat.onError(({ id, message, code }) => {
    if (!streaming || streaming.id !== id) return;
    const s = streaming; streaming = null;
    s.node.classList.remove('streaming');
    s.node.classList.add('error');
    s.node.textContent = message;
    history.pop(); // drop the user turn that failed so retry is clean
    setBusy(false);
    status(code === 'NO_KEY' ? 'add an API key in ⚙' : 'error', 'err', 4000);
    if (code === 'NO_KEY') setTimeout(openSettings, 400);
  });

  function submitFromInput() {
    const text = el.input.value;
    const image = pendingShot;
    if (!text.trim() && !image) {
      if (listening && transcriptText.trim()) return answerTranscript();
      focusInput(); return;
    }
    el.input.value = ''; autosize();
    clearShot();
    if (listening && transcriptText.trim()) {
      const prompt = `Live transcript so far:\n"""\n${transcriptText.trim().slice(-6000)}\n"""\n\n${text || 'Answer the most recent question in the transcript, or tell me the best thing to say next.'}`;
      return send(prompt, { image, display: text || 'Answer the transcript' });
    }
    send(text, { image });
  }

  function answerTranscript() {
    if (!transcriptText.trim()) { status('nothing heard yet', 'err', 2000); return; }
    const prompt = `Live transcript so far:\n"""\n${transcriptText.trim().slice(-6000)}\n"""\n\nAnswer the most recent question in the transcript. If there is no question, suggest the strongest thing to say next. Be brief.`;
    send(prompt, { display: 'Answer the transcript' });
  }

  // ---------- screenshot ----------
  async function takeShot({ andSend = true } = {}) {
    status('capturing…', 'busy');
    try {
      const b64 = await V.screenshot();
      status('', '');
      if (andSend) {
        const q = el.input.value.trim();
        el.input.value = ''; autosize();
        const ctx = listening && transcriptText.trim() ? `\n\nLive transcript for context:\n"""\n${transcriptText.trim().slice(-3000)}\n"""` : '';
        send((q || 'Look at my screen. If there is a question, problem, or code, solve it directly. Otherwise summarize what matters.') + ctx, { image: b64, display: q || 'What’s on my screen?' });
      } else {
        pendingShot = b64;
        el.shotChip.classList.remove('hidden');
        focusInput();
      }
    } catch (e) {
      status(e.code === 'NO_SCREEN_PERMISSION' ? 'screen permission needed' : 'capture failed', 'err', 5000);
      showPanel();
      const n = addAssistant(); n.classList.remove('streaming'); n.classList.add('error'); n.textContent = e.message;
    }
  }
  function clearShot() { pendingShot = null; el.shotChip.classList.add('hidden'); }
  el.shotRemove.addEventListener('click', clearShot);

  // ---------- listen mode ----------
  async function getAudioStream() {
    const want = settings?.audioSource || 'system';
    if (want === 'system') {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        s.getVideoTracks().forEach(t => t.stop());
        if (s.getAudioTracks().length) { el.tSource.textContent = 'system audio'; return s; }
      } catch (e) { console.warn('system audio unavailable, falling back to mic', e); }
    }
    await V.perm.askMic().catch(() => {});
    const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    el.tSource.textContent = 'microphone';
    return m;
  }

  function pickMime() {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  async function startListen() {
    if (listening) return;
    if (!settings?.hasOpenaiKey) {
      status('Listen needs an OpenAI key', 'err', 4000);
      openSettings(); return;
    }
    try {
      mediaStream = await getAudioStream();
    } catch (e) {
      status('no audio source', 'err', 4000);
      return;
    }
    listening = true;
    el.btnListen.classList.add('on');
    el.transcriptStrip.classList.remove('hidden');
    showPanel();
    status('listening', 'busy');
    recordChunk();
  }

  function recordChunk() {
    if (!listening || !mediaStream) return;
    const mime = pickMime();
    const parts = [];
    try {
      recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    } catch (e) { stopListen(); status('recorder failed', 'err', 4000); return; }
    recorder.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(parts, { type: mime || 'audio/webm' });
      if (listening) recordChunk();                 // keep rolling while we transcribe
      if (blob.size < 3000) return;                 // near-silence
      try {
        const buf = await blob.arrayBuffer();
        const text = await V.transcribe(buf, blob.type);
        appendTranscript(text);
      } catch (e) {
        status('transcribe error', 'err', 3000);
        console.warn(e);
      }
    };
    recorder.start();
    const secs = Math.max(3, Number(settings?.listenChunkSeconds) || 6);
    chunkTimer = setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, secs * 1000);
  }

  const JUNK = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|\s*)$/i;
  function appendTranscript(text) {
    text = (text || '').trim();
    if (!text || JUNK.test(text) || text === lastSeg) return;
    lastSeg = text;
    document.querySelectorAll('.t-body .seg-new').forEach(n => n.classList.remove('seg-new'));
    const span = document.createElement('span');
    span.className = 'seg-new';
    span.textContent = (transcriptText ? ' ' : '') + text;
    el.transcript.appendChild(span);
    transcriptText += (transcriptText ? ' ' : '') + text;
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function stopListen() {
    listening = false;
    clearTimeout(chunkTimer);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
    recorder = null;
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
    el.btnListen.classList.remove('on');
    status('', '');
    // keep the transcript visible so it can still be answered
    if (!transcriptText.trim()) el.transcriptStrip.classList.add('hidden');
    hidePanelIfEmpty();
  }
  function toggleListen() { listening ? stopListen() : startListen(); }

  el.btnClearT.addEventListener('click', () => {
    transcriptText = ''; lastSeg = ''; el.transcript.textContent = '';
    if (!listening) { el.transcriptStrip.classList.add('hidden'); hidePanelIfEmpty(); }
  });
  el.btnAnswer.addEventListener('click', answerTranscript);

  // ---------- clear ----------
  function clearAll() {
    if (streaming) V.chat.abort();
    history.length = 0;
    el.thread.innerHTML = '';
    el.input.value = ''; autosize();
    clearShot();
    hidePanelIfEmpty();
    status('cleared', '', 1200);
  }

  // ---------- composer ----------
  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(140, el.input.scrollHeight) + 'px';
  }
  el.input.addEventListener('input', autosize);
  el.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFromInput(); }
    if (e.key === 'Escape') { el.input.blur(); hidePanelIfEmpty(); }
  });
  el.btnSend.addEventListener('click', submitFromInput);
  el.btnStop.addEventListener('click', () => V.chat.abort());

  // ---------- bar buttons ----------
  el.btnAsk.addEventListener('click', () => {
    if (el.input.value.trim() || pendingShot) submitFromInput();
    else if (listening && transcriptText.trim()) answerTranscript();
    else focusInput();
  });
  el.btnShot.addEventListener('click', e => takeShot({ andSend: !e.altKey }));
  el.btnListen.addEventListener('click', toggleListen);
  el.btnHide.addEventListener('click', () => V.window.hide());
  el.btnSettings.addEventListener('click', () => el.settings.classList.contains('hidden') ? openSettings() : closeSettings());
  el.btnCloseSettings.addEventListener('click', closeSettings);
  el.btnQuit.addEventListener('click', () => V.window.quit());

  // ---------- global hotkeys ----------
  V.hotkeys.on(name => {
    switch (name) {
      case 'ask':
        if (document.activeElement === el.input && (el.input.value.trim() || pendingShot)) return submitFromInput();
        if (el.input.value.trim() || pendingShot) return submitFromInput();
        if (listening && transcriptText.trim()) return answerTranscript();
        return focusInput();
      case 'screenshot': return takeShot({ andSend: true });
      case 'listen': return toggleListen();
      case 'clear': return clearAll();
    }
  });
  V.window.onVisibility(v => {
    el.stage.classList.toggle('hiding', !v);
    if (v) setIgnore(true);
  });

  // ---------- settings ----------
  function segSet(seg, value) {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === value));
  }
  function refreshSettingsUI() {
    if (!settings) return;
    segSet(el.providerSeg, settings.provider);
    segSet(el.audioSeg, settings.audioSource);
    el.anthModel.value = settings.anthropicModel || '';
    el.oaiModel.value = settings.openaiModel || '';
    el.trModel.value = settings.transcribeModel || '';
    el.sysPrompt.value = settings.systemPrompt || '';
    el.opacity.value = settings.opacity;
    el.opacityVal.textContent = Math.round(settings.opacity * 100) + '%';
    el.anthState.textContent = settings.hasAnthropicKey ? 'saved' : 'not set';
    el.anthState.className = 'state ' + (settings.hasAnthropicKey ? 'ok' : 'bad');
    el.oaiState.textContent = settings.hasOpenaiKey ? 'saved' : 'not set';
    el.oaiState.className = 'state ' + (settings.hasOpenaiKey ? 'ok' : 'bad');
    el.anthKey.placeholder = settings.hasAnthropicKey ? '•••••••• (saved — paste to replace)' : 'sk-ant-…';
    el.oaiKey.placeholder = settings.hasOpenaiKey ? '•••••••• (saved — paste to replace)' : 'sk-…';
    el.encBadge.textContent = settings.encrypted ? 'keys encrypted' : 'keys stored locally';
    el.encBadge.classList.toggle('off', !settings.encrypted);
    paintModelPicker();
    V.perm.status().then(p => {
      const mac = V.platform === 'darwin';
      if (!mac) { el.permHint.textContent = ''; return; }
      const f = v => v === 'granted' ? '<span class="ok">granted</span>' : `<span class="bad">${v.replace('-', ' ')}</span>`;
      el.permHint.innerHTML = `macOS permissions — Screen Recording: ${f(p.screen)} · Microphone: ${f(p.mic)}. Screen Recording is needed for screenshots and system audio. Grant in System Settings → Privacy &amp; Security, then relaunch.`;
    });
  }
  async function patch(p) {
    settings = await V.settings.set(p);
    refreshSettingsUI();
  }

  // ---------- model picker ----------
  const PROVIDERS = [
    { id: 'anthropic', group: 'Claude · Anthropic', tag: 'CLAUDE', modelKey: 'anthropicModel', hasKey: 'hasAnthropicKey' },
    { id: 'openai', group: 'ChatGPT · OpenAI', tag: 'GPT', modelKey: 'openaiModel', hasKey: 'hasOpenaiKey' }
  ];
  let models = { anthropic: [], openai: [] };

  async function loadModels() {
    try { models = await V.settings.models(); } catch { /* keep what we have */ }
    paintModelPicker();
  }
  // the saved model always appears, even if it's custom or missing from the provider's list
  function modelsFor(p) {
    const list = models[p.id] || [];
    const cur = settings && settings[p.modelKey];
    return cur && !list.some(m => m.id === cur) ? [{ id: cur, name: cur }, ...list] : list;
  }
  function paintModelPicker() {
    if (!settings) return;
    const p = PROVIDERS.find(x => x.id === settings.provider) || PROVIDERS[0];
    const id = settings[p.modelKey];
    const m = modelsFor(p).find(x => x.id === id);
    el.mpProv.textContent = p.tag;
    el.mpProv.className = 'mp-prov ' + p.id;
    el.mpLabel.textContent = m ? m.name : (id || 'Pick a model');
    el.mpBtn.title = `Answering with ${id} — click to switch`;
    if (!el.mpMenu.classList.contains('hidden')) renderModelMenu();
  }
  function renderModelMenu() {
    el.mpMenu.innerHTML = '';
    for (const p of PROVIDERS) {
      const head = document.createElement('div');
      head.className = 'mp-group';
      head.innerHTML = esc(p.group) + (settings[p.hasKey] ? '' : ' <span class="nokey">· no key</span>');
      el.mpMenu.appendChild(head);
      for (const m of modelsFor(p)) {
        const on = settings.provider === p.id && settings[p.modelKey] === m.id;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mp-item' + (on ? ' on' : '') + (settings[p.hasKey] ? '' : ' dim');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', on);
        b.title = m.id;
        b.innerHTML = '<svg class="ck" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg><span class="nm"></span>';
        b.querySelector('.nm').textContent = m.name;
        b.addEventListener('click', () => pickModel(p, m));
        el.mpMenu.appendChild(b);
      }
    }
  }
  async function pickModel(p, m) {
    closeModelMenu();
    await patch({ provider: p.id, [p.modelKey]: m.id });
    if (!settings[p.hasKey]) status(`add an ${p.id === 'openai' ? 'OpenAI' : 'Anthropic'} key in Settings`, 'err', 4000);
    else status(m.name, '', 1500);
  }
  function openModelMenu() {
    renderModelMenu();
    el.mpMenu.classList.remove('hidden');
    el.mpBtn.setAttribute('aria-expanded', 'true');
    (el.mpMenu.querySelector('.mp-item.on') || el.mpMenu.querySelector('.mp-item'))?.focus();
  }
  function closeModelMenu() {
    el.mpMenu.classList.add('hidden');
    el.mpBtn.setAttribute('aria-expanded', 'false');
  }
  el.mpBtn.addEventListener('click', () => el.mpMenu.classList.contains('hidden') ? openModelMenu() : closeModelMenu());
  document.addEventListener('mousedown', e => { if (!e.target.closest('#modelPick')) closeModelMenu(); });
  el.mpMenu.addEventListener('keydown', e => {
    const items = [...el.mpMenu.querySelectorAll('.mp-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeModelMenu(); el.mpBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)]?.focus(); }
  });
  el.providerSeg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) patch({ provider: b.dataset.v }); });
  el.audioSeg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) patch({ audioSource: b.dataset.v }); });
  el.anthModel.addEventListener('change', () => patch({ anthropicModel: el.anthModel.value.trim() }));
  el.oaiModel.addEventListener('change', () => patch({ openaiModel: el.oaiModel.value.trim() }));
  el.trModel.addEventListener('change', () => patch({ transcribeModel: el.trModel.value.trim() }));
  el.sysPrompt.addEventListener('change', () => patch({ systemPrompt: el.sysPrompt.value }));
  el.opacity.addEventListener('input', () => { el.opacityVal.textContent = Math.round(el.opacity.value * 100) + '%'; });
  el.opacity.addEventListener('change', () => patch({ opacity: Number(el.opacity.value) }));

  async function saveKey(name, inputEl, stateEl) {
    const v = inputEl.value.trim();
    if (!v) return;
    settings = await V.settings.setKey(name, v);
    inputEl.value = '';
    refreshSettingsUI();
    stateEl.textContent = 'saved'; stateEl.className = 'state ok';
    status('key saved', '', 1500);
    loadModels();   // a new key unlocks that provider's live model list
  }
  async function testKey(name, stateEl) {
    stateEl.textContent = 'testing…'; stateEl.className = 'state';
    try { await V.settings.test(name); stateEl.textContent = 'works ✓'; stateEl.className = 'state ok'; }
    catch (e) { stateEl.textContent = (e.message || 'failed').replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 90); stateEl.className = 'state bad'; }
  }
  el.anthSave.addEventListener('click', () => saveKey('anthropic', el.anthKey, el.anthState));
  el.oaiSave.addEventListener('click', () => saveKey('openai', el.oaiKey, el.oaiState));
  el.anthKey.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey('anthropic', el.anthKey, el.anthState); });
  el.oaiKey.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey('openai', el.oaiKey, el.oaiState); });
  el.anthTest.addEventListener('click', () => testKey('anthropic', el.anthState));
  el.oaiTest.addEventListener('click', () => testKey('openai', el.oaiState));

  // ---------- hotkeys: display + recording ----------
  const mac = V.platform === 'darwin';
  function prettyAccel(accel) {
    if (!accel) return 'off';
    return accel
      .replace('CommandOrControl', mac ? '⌘' : 'Ctrl').replace('CmdOrCtrl', mac ? '⌘' : 'Ctrl')
      .replace('Command', '⌘').replace('Cmd', '⌘')
      .replace('Control', mac ? '⌃' : 'Ctrl').replace('Ctrl', mac ? '⌃' : 'Ctrl')
      .replace('Option', '⌥').replace('Alt', mac ? '⌥' : 'Alt')
      .replace('Shift', '⇧').replace('Super', mac ? '⌘' : 'Win').replace('Meta', mac ? '⌘' : 'Win')
      .replace('Enter', '↵').replace('Esc', '⎋').replace('Backspace', '⌫').replace('Delete', '⌦').replace('Space', '␣').replace('Tab', '⇥')
      .replace('Up', '↑').replace('Down', '↓').replace('Left', '←').replace('Right', '→')
      .replace(/\+/g, mac ? '' : '+');
  }
  let hotkeys = [];
  let recording = null;   // {id, kbd}

  function paintBar() {
    document.querySelectorAll('[data-hk]').forEach(k => {
      const h = hotkeys.find(x => x.id === k.dataset.hk);
      if (h) k.textContent = prettyAccel(h.accel);
    });
  }
  function renderHotkeys() {
    el.hotkeyList.innerHTML = hotkeys.map(h => {
      const cls = ['hk', h.status === 'failed' ? 'failed' : '', !h.accel ? 'off' : '', h.custom ? 'custom' : ''].filter(Boolean).join(' ');
      const title = h.status === 'failed' ? 'Another app owns this combo — pick a different one' : (h.custom ? `default: ${prettyAccel(h.default)}` : 'click to change');
      return `<li><span>${h.label}</span><kbd class="${cls}" data-id="${h.id}" title="${title}" tabindex="0">${prettyAccel(h.accel)}</kbd></li>`;
    }).join('');
    paintBar();
  }

  // KeyboardEvent -> Electron accelerator
  const CODE_MAP = {
    Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc',
    Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert'
  };
  function accelFromEvent(e) {
    let key = null;
    const c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
    else if (/^Digit\d$/.test(c)) key = c.slice(5);
    else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
    else if (/^F\d{1,2}$/.test(c)) key = c;
    else if (CODE_MAP[c]) key = CODE_MAP[c];
    if (!key) return null;
    const mods = [];
    if (e.metaKey) mods.push(mac ? 'Command' : 'Super');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return [...mods, key].join('+');
  }

  function stopRecording(cancelled) {
    if (!recording) return;
    recording.kbd.classList.remove('rec');
    recording = null;
    if (cancelled) V.hotkeys.resume().then(list => { hotkeys = list; renderHotkeys(); });
  }
  async function startRecording(kbd) {
    if (recording) stopRecording(true);
    recording = { id: kbd.dataset.id, kbd };
    kbd.classList.add('rec');
    kbd.textContent = 'press keys…';
    kbd.focus();
    el.hkMsg.textContent = 'Press the new combination. Esc to cancel, ⌫ to disable this hotkey.';
    await V.hotkeys.suspend();   // so the combo doesn't fire an action while we record
  }
  el.hotkeyList.addEventListener('click', e => {
    const kbd = e.target.closest('kbd.hk');
    if (kbd) startRecording(kbd);
  });
  window.addEventListener('keydown', async e => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    const isMod = ['Meta', 'Control', 'Alt', 'Shift'].includes(e.key);
    if (isMod) return;                            // wait for the real key
    if (e.code === 'Escape' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) { el.hkMsg.textContent = ''; return stopRecording(true); }
    const { id } = recording;
    let accel;
    if (e.code === 'Backspace' && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) accel = '';
    else {
      accel = accelFromEvent(e);
      if (!accel) { el.hkMsg.textContent = 'That key can’t be used. Try another.'; return; }
    }
    stopRecording(false);
    try {
      hotkeys = await V.hotkeys.set(id, accel);
      renderHotkeys();
      const h = hotkeys.find(x => x.id === id);
      el.hkMsg.textContent = h.status === 'failed'
        ? `${prettyAccel(accel)} is taken by another app or macOS. Pick a different one.`
        : (accel ? `Saved: ${h.label} → ${prettyAccel(accel)}` : `${h.label} disabled`);
    } catch (err) {
      hotkeys = await V.hotkeys.resume();
      renderHotkeys();
      el.hkMsg.textContent = (err.message || 'invalid').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  }, true);
  // clicking elsewhere cancels a pending recording
  document.addEventListener('mousedown', e => { if (recording && !e.target.closest('kbd.hk')) { el.hkMsg.textContent = ''; stopRecording(true); } });
  el.hkReset.addEventListener('click', async () => {
    hotkeys = await V.hotkeys.reset();
    renderHotkeys();
    el.hkMsg.textContent = 'Hotkeys reset to defaults.';
  });

  // ---------- updates ----------
  let latestUpdate = null;
  async function checkUpdates({ silent = false } = {}) {
    el.btnCheckUpdate.disabled = true;
    if (!silent) el.updMsg.textContent = 'Checking…';
    const info = await V.update.check();
    el.btnCheckUpdate.disabled = false;
    latestUpdate = info;
    if (info.current) el.verState.textContent = 'v' + info.current;
    if (info.error) {
      el.btnGetUpdate.classList.add('hidden');
      if (!silent) el.updMsg.textContent = 'Couldn’t check for updates: ' + info.error;
      return info;
    }
    if (info.hasUpdate) {
      el.updMsg.innerHTML = `Update available — <strong>v${info.latest}</strong> (you have v${info.current}).`;
      el.btnGetUpdate.classList.remove('hidden');
      if (silent) status('update available — see Settings', '', 6000);
    } else {
      el.btnGetUpdate.classList.add('hidden');
      if (!silent) el.updMsg.textContent = `You’re on the latest version (v${info.current}).`;
    }
    return info;
  }
  el.btnCheckUpdate.addEventListener('click', () => checkUpdates());
  el.btnGetUpdate.addEventListener('click', () => { if (latestUpdate && latestUpdate.url) V.update.open(latestUpdate.url); });

  // ---------- boot ----------
  (async () => {
    settings = await V.settings.get();
    hotkeys = await V.hotkeys.list();
    renderHotkeys();
    refreshSettingsUI();
    loadModels();
    V.update.version().then(v => { el.verState.textContent = 'v' + v; }).catch(() => {});
    checkUpdates({ silent: true }).catch(() => {});
    if (!settings.hasAnthropicKey && !settings.hasOpenaiKey) {
      openSettings();
      status('add an API key to start', 'err');
    }
  })();
})();
