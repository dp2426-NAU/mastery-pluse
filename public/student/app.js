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
      card.className = 'topic-card';
      const scoreClass = t.myScore == null ? '' : (t.myScore >= 75 ? 'good' : t.myScore >= 50 ? '' : 'bad');
      card.innerHTML = `<p class="name">${t.name}</p><p class="score ${scoreClass}">${t.myScore == null ? 'Not attempted' : t.myScore + '%'}</p>`;
      card.onclick = () => startExam(t.key);
      grid.appendChild(card);
    });
  }

  function renderItemInput(item, container, onChange) {
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
          onChange();
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
      ta.oninput = () => { card.dataset.text = ta.value; onChange(); };
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
  function clearExamTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function startExamTimer(seconds, onExpire) {
    clearExamTimer();
    const el = document.getElementById('examTimer');
    let remaining = seconds;
    const render = () => {
      const m = Math.floor(remaining / 60), s = remaining % 60;
      el.textContent = `${m}:${String(s).padStart(2, '0')}`;
      el.classList.toggle('warn', remaining <= 60 && remaining > 20);
      el.classList.toggle('critical', remaining <= 20);
    };
    render();
    timerInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { clearExamTimer(); el.textContent = '0:00'; onExpire(); return; }
      render();
    }, 1000);
  }

  function buildExamView(data, submitFn, topicKey) {
    bannerArea.style.display = 'none';
    view.innerHTML = `
      <div class="exam-head">
        <h2 style="font-family:var(--serif); margin:0;">${data.topicName}</h2>
        <div class="exam-timer" id="examTimer">--:--</div>
      </div>
      <div id="items"></div>
      <div class="submit-row"><button id="submitExam">Submit</button></div>`;
    const itemsEl = document.getElementById('items');

    // Tell the instructor dashboard this student is starting — it lights up
    // a live progress chip immediately, before a single question is answered.
    socket.emit('exam:start', { topicKey, topicName: data.topicName, total: data.items.length });

    let answeredCount = -1;
    const reportProgress = () => {
      const answered = [...itemsEl.children].filter(c => {
        if (c.dataset.type === 'quiz') return c.dataset.selectedIndex !== undefined;
        return (c.dataset.text || '').trim().length > 0;
      }).length;
      if (answered === answeredCount) return;
      answeredCount = answered;
      socket.emit('exam:progress', { answered });
    };

    data.items.forEach(it => renderItemInput(it, itemsEl, reportProgress));

    let submitted = false;
    const doSubmit = async () => {
      if (submitted) return;
      submitted = true;
      clearExamTimer();
      const cards = [...itemsEl.children];
      const responses = cards.map(c => {
        const base = { itemId: Number(c.dataset.itemId), type: c.dataset.type, confidence: Number(c.dataset.confidence) };
        if (c.dataset.type === 'quiz') base.selectedIndex = c.dataset.selectedIndex !== undefined ? Number(c.dataset.selectedIndex) : -1;
        else base.text = c.dataset.text || '';
        return base;
      });
      const result = await submitFn(responses);
      renderResults(data, result);
    };
    document.getElementById('submitExam').onclick = doSubmit;

    startExamTimer(data.timeLimitSeconds || 300, () => {
      showToast('⏱ Time’s up — submitting what you’ve got.', 'warn');
      doSubmit();
    });
  }

  async function startExam(topicKey) {
    const data = await (await fetch('/api/student/exam/' + topicKey, { headers: H })).json();
    buildExamView(data, async (responses) => {
      const res = await fetch(`/api/student/exam/${topicKey}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses }) });
      return res.json();
    }, topicKey);
  }

  async function startRemediation(remId) {
    const data = await (await fetch('/api/student/remediation/' + remId, { headers: H })).json();
    buildExamView(data, async (responses) => {
      const res = await fetch(`/api/student/exam/${data.topic}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses }) });
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

  showTopics();
  loadBanner();
})();
