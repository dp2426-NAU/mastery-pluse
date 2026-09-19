(function () {
  const token = sessionStorage.getItem('mp_token');
  const user = JSON.parse(sessionStorage.getItem('mp_user') || 'null');
  if (!token || !user || user.role !== 'student') { window.location.href = '/student/login.html'; return; }

  document.getElementById('whoami').textContent = user.name;
  document.getElementById('logoutBtn').onclick = () => {
    sessionStorage.removeItem('mp_token'); sessionStorage.removeItem('mp_user');
    window.location.href = '/student/login.html';
  };

  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const view = document.getElementById('view');
  const bannerArea = document.getElementById('bannerArea');

  // ---- live channel: the instructor dashboard watches this student's
  // progress in real time, and this tab hears remediation broadcasts live. ----
  const socket = io({ auth: { token } });
  attachLiveBadge(socket);

  // "N students online right now" — the same headcount the instructor sees,
  // anonymized, shown next to this student's connection badge.
  const onlineTicker = document.createElement('span');
  onlineTicker.className = 'online-ticker';
  onlineTicker.hidden = true;
  document.getElementById('whoami').parentNode.insertBefore(onlineTicker, document.getElementById('whoami'));
  socket.on('presence:online', ({ count }) => {
    onlineTicker.hidden = false;
    onlineTicker.textContent = `${count} student${count === 1 ? '' : 's'} online`;
  });

  socket.on('remediation:new', (r) => {
    showToast(`📌 Your instructor added practice for ${r.topicName} — check your dashboard.`, 'good');
    // Only re-render immediately if we're sitting on the topics screen;
    // otherwise it'll pick up next time loadBanner runs.
    if (!view.querySelector('#grid')) return;
    loadBanner();
  });

  // The instructor granted a retake after a webcam-strike failure — the
  // topic unlocks immediately. Only meaningful from the topics screen
  // (can't happen mid-exam, since the failure that locked it already ended
  // whatever exam was running).
  socket.on('exam:retakeGranted', (r) => {
    showToast(`✅ Your instructor granted you a retake for ${r.topicName} — you're clear to try again.`, 'good');
    if (view.querySelector('#grid')) showTopics();
  });

  async function loadBanner() {
    const rows = await (await fetch('/api/student/remediation', { headers: H })).json();
    if (!rows.length) { bannerArea.innerHTML = ''; return; }
    const r = rows[0];
    bannerArea.innerHTML = `
      <div class="banner">
        <span>📌 ${r.message}</span>
        <button id="practiceNowBtn">Practice now</button>
      </div>`;
    document.getElementById('practiceNowBtn').onclick = () => startRemediation(r.id);
  }

  async function showTopics() {
    bannerArea.style.display = '';
    const topics = await (await fetch('/api/student/topics', { headers: H })).json();
    view.innerHTML = `<div class="topic-grid" id="grid"></div>`;
    const grid = document.getElementById('grid');
    topics.forEach(t => {
      const card = document.createElement('button');
      card.className = 'topic-card' + (t.locked ? ' locked' : '');
      const scoreClass = t.myScore == null ? '' : (t.myScore >= 75 ? 'good' : t.myScore >= 50 ? '' : 'bad');
      card.innerHTML = t.locked
        ? `<p class="name">${t.name}</p><p class="score bad">🔒 Locked — ask your instructor</p>`
        : `<p class="name">${t.name}</p><p class="score ${scoreClass}">${t.myScore == null ? 'Not attempted' : t.myScore + '%'}</p>`;
      card.onclick = t.locked
        ? () => showToast('This topic is locked after a webcam integrity failure. Your instructor needs to grant a retake first.', 'warn')
        : () => startExam(t.key);
      grid.appendChild(card);
    });
  }

  // ---- exam integrity: detected and logged, never claimed to "prevent"
  // anything a browser genuinely can't stop (like a tab close). ----
  let integrityEvents = [];
  let watchingIntegrity = false;
  function logIntegrityEvent(type) { integrityEvents.push({ type, ts: Date.now() }); }
  function onVisibilityChange() { if (document.hidden) logIntegrityEvent('tab-hidden'); }
  function onFullscreenChange() { if (watchingIntegrity && !document.fullscreenElement) logIntegrityEvent('fullscreen-exited'); }
  function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }

  function startIntegrityWatch() {
    integrityEvents = [];
    watchingIntegrity = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Best-effort: some browsers/contexts refuse this. Never block the exam if it does.
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }
  function stopIntegrityWatch() {
    watchingIntegrity = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }

  // ---- webcam attention monitoring: runs entirely in this tab (see
  // webcam-monitor.js) — no video ever leaves the browser. A short consent
  // notice is shown before the camera is requested; declining just skips
  // monitoring rather than blocking the exam. ----
  let webcamActive = false;
  let currentTopicKey = null;

  function showConsentThenStart(onDone) {
    const overlay = document.createElement('div');
    overlay.className = 'consent-overlay';
    overlay.innerHTML = `
      <div class="consent-card">
        <p class="consent-title">📷 Proctoring notice</p>
        <p class="consent-body">This exam checks, using your camera, whether you're looking at the screen — as part of your course's academic integrity policy. Detection runs only in your browser; no video is recorded or uploaded. You'll see an on-screen reminder for the 1st and 2nd time you look away. <strong>On the 3rd, your exam ends immediately and is recorded as failed</strong> — your instructor gets a timestamp, a count, and one still image.</p>
        <div class="consent-actions">
          <button type="button" class="consent-decline">Continue without camera</button>
          <button type="button" class="consent-accept">Enable camera &amp; continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.consent-accept').onclick = () => { overlay.remove(); onDone(true); };
    overlay.querySelector('.consent-decline').onclick = () => { overlay.remove(); onDone(false); };
  }

  function setCamStatus(text) {
    const el = document.getElementById('camStatus');
    if (el) el.textContent = text;
  }

  // Set inside buildExamView to a function that force-ends the exam
  // currently on screen as a hard fail — called from the webcam strike
  // handler below, which lives outside that closure.
  let forceFailCurrentExam = null;

  async function startWebcamMonitor() {
    if (!window.MasteryPulseWebcam) { setCamStatus('🎥 Camera monitoring unavailable'); return; }
    setCamStatus('🎥 Starting camera…');
    const result = await window.MasteryPulseWebcam.start((count, snapshot) => {
      // Strikes 1-2: a private, on-screen nudge — the student always knows
      // this is running and gets a chance to self-correct. Strike 3: the
      // exam ends immediately as a hard fail — no pause, no waiting on
      // anyone. The instructor is notified with the same timestamp/count/
      // snapshot either way; there's just no "approve to continue" step.
      if (count < 3) {
        showToast(`👀 Attention check ${count}/3 — please keep your eyes on the screen.`, 'warn');
      } else {
        socket.emit('exam:webcamAlert', { topicKey: currentTopicKey, count, snapshot });
        if (forceFailCurrentExam) forceFailCurrentExam();
      }
    });
    webcamActive = result.ok;
    setCamStatus(result.ok ? '🎥 Camera monitoring on' : '🎥 Camera unavailable — continuing without it');
  }

  function stopWebcamMonitor() {
    if (webcamActive && window.MasteryPulseWebcam) window.MasteryPulseWebcam.stop();
    webcamActive = false;
  }

  function renderItemInput(item, container) {
    const card = document.createElement('div');
    card.className = 'item-card';
    const kindLabel = item.type === 'quiz' ? 'Quiz question' : item.type === 'task' ? 'Task' : 'Short answer';
    card.innerHTML = `<p class="item-kind">${kindLabel}</p><p class="item-prompt">${item.prompt}</p>`;

    if (item.type === 'quiz') {
      const optsWrap = document.createElement('div');
      item.options.forEach((opt, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'opt'; b.textContent = opt;
        b.onclick = () => {
          [...optsWrap.children].forEach(c => c.classList.remove('selected'));
          b.classList.add('selected');
          card.dataset.selectedIndex = i;
          // Graded server-side instantly — the instructor sees a ✓/✗ trail
          // next to this student's name as they pick, not just an answered-count.
          socket.emit('exam:answer', { itemId: item.id, selectedIndex: i });
        };
        optsWrap.appendChild(b);
      });
      card.appendChild(optsWrap);
    } else {
      const ta = document.createElement('textarea');
      ta.placeholder = item.type === 'task' ? 'Describe your approach…' : 'Write your answer…';
      ta.oninput = () => { card.dataset.text = ta.value; };
      card.appendChild(ta);
    }

    // Confidence self-rating — lets the instructor spot the difference
    // between "wrong, and knew it" and "wrong, but sure they were right."
    card.dataset.confidence = '3';
    const confWrap = document.createElement('div');
    confWrap.className = 'confidence';
    confWrap.innerHTML = `
      <label>How sure are you? <span class="confidence-label">Somewhat sure</span></label>
      <input type="range" min="1" max="5" value="3" class="confidence-slider">
    `;
    const slider = confWrap.querySelector('.confidence-slider');
    const labelEl = confWrap.querySelector('.confidence-label');
    const CONF_WORDS = { 1: 'Just guessing', 2: 'Not very sure', 3: 'Somewhat sure', 4: 'Fairly confident', 5: 'Very confident' };
    slider.oninput = () => {
      card.dataset.confidence = slider.value;
      labelEl.textContent = CONF_WORDS[slider.value];
    };
    card.appendChild(confWrap);

    card.dataset.itemId = item.id;
    card.dataset.type = item.type;
    container.appendChild(card);
  }

  let timerInterval = null;
  let timerRemaining = 0;
  let timerOnExpire = null;
  function clearExamTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  function renderExamTimer() {
    const el = document.getElementById('examTimer');
    if (!el) return;
    const m = Math.floor(timerRemaining / 60), s = timerRemaining % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('warn', timerRemaining <= 60 && timerRemaining > 20);
    el.classList.toggle('critical', timerRemaining <= 20);
  }
  function startExamTimer(seconds, onExpire) {
    clearExamTimer();
    timerRemaining = seconds;
    timerOnExpire = onExpire;
    renderExamTimer();
    timerInterval = setInterval(() => {
      timerRemaining -= 1;
      if (timerRemaining <= 0) { clearExamTimer(); timerRemaining = 0; renderExamTimer(); timerOnExpire(); return; }
      renderExamTimer();
    }, 1000);
  }
  // One question at a time, no way back — once you move on, that answer is
  // locked in. Matches how a real proctored exam works, and it's what makes
  // "answered so far" a meaningful, honest number for the live presence chip.
  function buildExamView(data, submitFn, topicKey) {
    currentTopicKey = topicKey;
    bannerArea.style.display = 'none';
    view.innerHTML = `
      <div class="exam-head">
        <h2 style="font-family:var(--serif); margin:0;">${data.topicName}</h2>
        <span class="cam-status" id="camStatus"></span>
        <div class="exam-timer" id="examTimer">--:--</div>
      </div>
      <div class="progress-dots" id="progressDots"></div>
      <div id="itemStage"></div>
      <div class="submit-row"><button id="nextBtn"></button></div>
      <p class="lock-note">Once you move to the next question you can't come back to this one — answer carefully.</p>
    `;
    const stage = document.getElementById('itemStage');
    const dotsEl = document.getElementById('progressDots');
    const nextBtn = document.getElementById('nextBtn');

    socket.emit('exam:start', { topicKey, topicName: data.topicName, total: data.items.length });
    startIntegrityWatch();
    showConsentThenStart((accepted) => {
      if (accepted) startWebcamMonitor();
      else setCamStatus('🎥 Camera monitoring declined');
    });

    const locked = [];
    let index = 0;

    function renderDots() {
      dotsEl.innerHTML = data.items.map((_, i) => {
        const cls = i < index ? 'done' : i === index ? 'current' : 'upcoming';
        return `<span class="dot ${cls}"></span>`;
      }).join('');
    }

    function renderStep() {
      stage.innerHTML = '';
      renderItemInput(data.items[index], stage);
      renderDots();
      nextBtn.textContent = index === data.items.length - 1 ? 'Submit' : 'Next question →';
      socket.emit('exam:progress', { answered: index });
    }

    function finalizeCurrent() {
      const card = stage.firstElementChild;
      if (!card) return;
      const base = { itemId: Number(card.dataset.itemId), type: card.dataset.type, confidence: Number(card.dataset.confidence) };
      if (card.dataset.type === 'quiz') base.selectedIndex = card.dataset.selectedIndex !== undefined ? Number(card.dataset.selectedIndex) : -1;
      else base.text = card.dataset.text || '';
      locked.push(base);
    }

    let submitted = false;
    const doSubmit = async (failed) => {
      if (submitted) return;
      submitted = true;
      clearExamTimer();
      stopIntegrityWatch();
      stopWebcamMonitor();
      socket.emit('exam:progress', { answered: data.items.length });
      const result = await submitFn(locked, integrityEvents.slice(), !!failed);
      if (failed) renderFailedResults(data);
      else renderResults(data, result);
    };

    // Called from the webcam strike handler (outside this closure) the
    // instant a 3rd strike fires — ends the exam right where it stands.
    forceFailCurrentExam = () => {
      finalizeCurrent();
      doSubmit(true);
    };

    nextBtn.onclick = () => {
      finalizeCurrent();
      if (index === data.items.length - 1) { doSubmit(); return; }
      index += 1;
      renderStep();
    };

    renderStep();

    startExamTimer(data.timeLimitSeconds || 300, () => {
      showToast('⏱ Time’s up — submitting what you’ve got.', 'warn');
      finalizeCurrent();
      doSubmit();
    });
  }

  async function startExam(topicKey) {
    const data = await (await fetch('/api/student/exam/' + topicKey, { headers: H })).json();
    buildExamView(data, async (responses, events, failed) => {
      const res = await fetch(`/api/student/exam/${topicKey}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses, integrityEvents: events, forcedFail: failed }) });
      return res.json();
    }, topicKey);
  }

  async function startRemediation(remId) {
    const data = await (await fetch('/api/student/remediation/' + remId, { headers: H })).json();
    buildExamView(data, async (responses, events, failed) => {
      const res = await fetch(`/api/student/exam/${data.topic}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses, integrityEvents: events, forcedFail: failed }) });
      return res.json();
    }, data.topic);
  }

  function renderResults(data, result) {
    const scoreClass = result.topicScore >= 75 ? 'good' : result.topicScore >= 50 ? 'mid' : 'bad';
    const compareLine = result.classAverage != null
      ? `You: ${result.topicScore}% · Class average: ${result.classAverage}%`
      : `You: ${result.topicScore}%`;

    const itemHtml = result.results.map(r => {
      if (r.type === 'quiz') {
        const overconfident = !r.correct && r.confidence >= 4;
        return `<div class="result-item ${r.correct ? 'right' : 'wrong'}">
          <strong>${r.correct ? 'Correct' : 'Missed'}:</strong> ${r.question}<br>
          ${r.correct ? '' : `<span style="color:var(--good)">Correct answer: ${r.options[r.correctIndex]}</span>`}
          ${overconfident ? `<div class="tag" style="margin-top:6px;">rated yourself confident, but missed this one</div>` : ''}
        </div>`;
      }
      if (r.type === 'task') {
        return `<div class="result-item ${r.score >= 70 ? 'right' : 'wrong'}">
          <strong>Task score: ${r.score}%</strong><br>
          ${r.missing.length ? `Consider mentioning: ${r.missing.join(', ')}` : 'Covered the key points.'}
        </div>`;
      }
      return `<div class="result-item pending"><strong>Saved</strong> — awaiting instructor review.</div>`;
    }).join('');

    view.innerHTML = `
      <div class="results">
        <p style="color:var(--text-muted);">${data.topicName} — results</p>
        <p class="score-big ${scoreClass}">${result.topicScore}%</p>
        <p class="compare">${compareLine}</p>
      </div>
      ${itemHtml}
      <div style="text-align:center;"><span class="back-link" id="backLink">← Back to topics</span></div>
    `;
    document.getElementById('backLink').onclick = () => { showTopics(); loadBanner(); };
    showToast(`Submitted — instructor's heatmap just updated live.`, 'good');
  }

  // A 3rd webcam strike ends the exam here — a hard fail, not partial
  // credit for what was answered before the flag. What was actually
  // answered is still saved underneath (visible to the instructor), but
  // this screen deliberately doesn't show it as a normal result.
  function renderFailedResults(data) {
    view.innerHTML = `
      <div class="results">
        <p style="color:var(--text-muted);">${data.topicName} — exam ended</p>
        <p class="score-big bad">❌ Failed</p>
        <p class="compare">Recorded score: 0%</p>
      </div>
      <div class="result-item wrong">
        <strong>Ended for a webcam integrity violation</strong><br>
        Your browser detected repeated attention alerts (looking away from the screen 3+ times) during this exam. It ended immediately and was recorded as failed. Your instructor has been notified, with a timestamp and a snapshot from that moment.
      </div>
      <div style="text-align:center;"><span class="back-link" id="backLink">← Back to topics</span></div>
    `;
    document.getElementById('backLink').onclick = () => { showTopics(); loadBanner(); };
    showToast('Exam ended and recorded as failed — repeated webcam attention alerts.', 'warn');
  }

  showTopics();
  loadBanner();
})();
