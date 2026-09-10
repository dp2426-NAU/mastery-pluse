(function () {
  const token = localStorage.getItem('mp_token');
  const user = JSON.parse(localStorage.getItem('mp_user') || 'null');
  if (!token || !user || user.role !== 'student') { window.location.href = '/student/login.html'; return; }

  document.getElementById('whoami').textContent = user.name;
  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('mp_token'); localStorage.removeItem('mp_user');
    window.location.href = '/student/login.html';
  };

  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const view = document.getElementById('view');
  const bannerArea = document.getElementById('bannerArea');

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
    card.dataset.itemId = item.id;
    card.dataset.type = item.type;
    container.appendChild(card);
  }

  function buildExamView(data, submitFn) {
    bannerArea.style.display = 'none';
    view.innerHTML = `<h2 style="font-family:var(--serif); margin-bottom:16px;">${data.topicName}</h2><div id="items"></div><div class="submit-row"><button id="submitExam">Submit</button></div>`;
    const itemsEl = document.getElementById('items');
    data.items.forEach(it => renderItemInput(it, itemsEl));
    document.getElementById('submitExam').onclick = async () => {
      const cards = [...itemsEl.children];
      const responses = cards.map(c => {
        const base = { itemId: Number(c.dataset.itemId), type: c.dataset.type };
        if (c.dataset.type === 'quiz') base.selectedIndex = c.dataset.selectedIndex !== undefined ? Number(c.dataset.selectedIndex) : -1;
        else base.text = c.dataset.text || '';
        return base;
      });
      const result = await submitFn(responses);
      renderResults(data, result);
    };
  }

  async function startExam(topicKey) {
    const data = await (await fetch('/api/student/exam/' + topicKey, { headers: H })).json();
    buildExamView(data, async (responses) => {
      const res = await fetch(`/api/student/exam/${topicKey}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses }) });
      return res.json();
    });
  }

  async function startRemediation(remId) {
    const data = await (await fetch('/api/student/remediation/' + remId, { headers: H })).json();
    buildExamView(data, async (responses) => {
      const res = await fetch(`/api/student/exam/${data.topic}/submit`, { method: 'POST', headers: H, body: JSON.stringify({ responses }) });
      return res.json();
    });
  }

  function renderResults(data, result) {
    const scoreClass = result.topicScore >= 75 ? 'good' : result.topicScore >= 50 ? 'mid' : 'bad';
    const compareLine = result.classAverage != null
      ? `You: ${result.topicScore}% · Class average: ${result.classAverage}%`
      : `You: ${result.topicScore}%`;

    const itemHtml = result.results.map(r => {
      if (r.type === 'quiz') {
        return `<div class="result-item ${r.correct ? 'right' : 'wrong'}">
          <strong>${r.correct ? 'Correct' : 'Missed'}:</strong> ${r.question}<br>
          ${r.correct ? '' : `<span style="color:var(--good)">Correct answer: ${r.options[r.correctIndex]}</span>`}
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
  }

  showTopics();
  loadBanner();
})();
