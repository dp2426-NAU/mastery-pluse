(function () {
  const token = sessionStorage.getItem('mp_token');
  const user = JSON.parse(sessionStorage.getItem('mp_user') || 'null');
  if (!token || !user || user.role !== 'instructor') { window.location.href = '/instructor/login.html'; return; }

  document.getElementById('whoami').textContent = user.name;
  document.getElementById('logoutBtn').onclick = () => {
    sessionStorage.removeItem('mp_token'); sessionStorage.removeItem('mp_user');
    window.location.href = '/instructor/login.html';
  };

  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const heatmapArea = document.getElementById('heatmapArea');
  const qaQueue = document.getElementById('qaQueue');
  const overlay = document.getElementById('overlay');
  const drawer = document.getElementById('drawer');
  const activityFeed = document.getElementById('activityFeed');
  const onlineCountEl = document.getElementById('onlineCount');
  const activeChipsEl = document.getElementById('activeChips');

  function band(score) {
    if (score == null) return 'none';
    if (score < 50) return 'low';
    if (score < 75) return 'mid';
    return 'high';
  }

  // Remembers the last-rendered score per student/topic so a re-render can
  // flash exactly the cell(s) that actually changed, instead of silently
  // swapping the whole table.
  let lastScores = {};
  let lastHeatmapData = null; // kept around for the CSV export button

  // ---- sound + full-width flash: makes a live event unmissable from the
  // back of a room, without anyone needing to know where to look. ----
  let audioCtx = null;
  let soundOn = false;
  const soundToggle = document.getElementById('soundToggle');
  soundToggle.onclick = () => {
    soundOn = !soundOn;
    if (soundOn && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (soundOn && audioCtx.state === 'suspended') audioCtx.resume();
    soundToggle.textContent = soundOn ? '🔊 Sound on' : '🔈 Enable sound';
    soundToggle.classList.toggle('on', soundOn);
  };
  function playBeep(freq, duration) {
    if (!soundOn || !audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration + 0.02);
  }
  function flashEventBar(color) {
    const bar = document.getElementById('eventBar');
    bar.style.background = color;
    bar.classList.remove('flash');
    void bar.offsetWidth; // restart the animation
    bar.classList.add('flash');
  }

  function timeLabel(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function pushFeedItem(html) {
    if (activityFeed.querySelector('.empty')) activityFeed.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'feed-item';
    row.innerHTML = html;
    activityFeed.prepend(row);
    // Keep the feed short so it stays a "ticker," not a scrollable log.
    [...activityFeed.children].slice(8).forEach(el => el.remove());
  }

  async function loadHeatmap(flashKey) {
    const data = await (await fetch('/api/instructor/heatmap', { headers: H })).json();
    lastHeatmapData = data;
    if (data.students.length === 0) {
      heatmapArea.innerHTML = '<p class="empty">No students yet.</p>';
      return;
    }
    let html = '<table class="heat"><thead><tr><th>Student</th>';
    data.topics.forEach(t => {
      html += `<th>
        ${t.name}
        <button class="remediate-btn" data-topic="${t.key}" data-name="${t.name}">Remediate</button>
        <div class="misconception-row">${t.topMisconception ? `Common issue: ${t.topMisconception.tag.replace(/-/g, ' ')} (${t.topMisconception.n})` : 'No misses yet'}${t.pendingQA ? ` · ${t.pendingQA} pending` : ''}</div>
      </th>`;
    });
    html += '</tr></thead><tbody>';
    const nextScores = {};
    data.students.forEach(s => {
      html += `<tr><td>${s.name}</td>`;
      data.topics.forEach(t => {
        const score = s.scores[t.key];
        const key = s.id + ':' + t.key;
        nextScores[key] = score;
        const changed = flashKey && key === flashKey;
        html += `<td><span class="cell ${band(score)}${changed ? ' flash' : ''}" data-student="${s.id}" data-topic="${t.key}" data-name="${s.name}" data-topicname="${t.name}" data-key="${key}">${score == null ? '—' : score + '%'}</span></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    heatmapArea.innerHTML = html;
    lastScores = nextScores;

    heatmapArea.querySelectorAll('.cell:not(.none)').forEach(cell => {
      cell.onclick = () => openDetail(cell.dataset.student, cell.dataset.topic, cell.dataset.name, cell.dataset.topicname);
    });
    heatmapArea.querySelectorAll('.remediate-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        btn.textContent = 'Sending…';
        await fetch('/api/instructor/remediate', { method: 'POST', headers: H, body: JSON.stringify({ topicKey: btn.dataset.topic }) });
        btn.textContent = 'Sent ✓';
        showToast(`Remediation broadcast for ${btn.dataset.name} — students will see it now.`, 'good');
        loadRemediationImpact();
        setTimeout(() => { btn.textContent = 'Remediate'; }, 2000);
      };
    });
  }

  async function openDetail(studentId, topicKey, studentName, topicName) {
    const subs = await (await fetch(`/api/instructor/detail/${studentId}/${topicKey}`, { headers: H })).json();
    const html = subs.map(s => {
      if (s.type === 'quiz') {
        const correct = s.selectedIndex === s.correctIndex;
        return `<div class="detail-item ${correct ? 'right' : 'wrong'}">
          <strong>${correct ? 'Correct' : 'Missed'}:</strong> ${s.prompt}<br>
          ${correct ? '' : `Answered: "${s.options[s.selectedIndex] ?? '—'}" · Correct: "${s.options[s.correctIndex]}"`}
          ${s.misconceptionTag ? `<div class="tag">${s.misconceptionTag.replace(/-/g, ' ')}</div>` : ''}
        </div>`;
      }
      if (s.type === 'task') {
        return `<div class="detail-item ${s.autoScore >= 70 ? 'right' : 'wrong'}">
          <strong>Task — ${s.autoScore}%</strong><br>${s.prompt}
          <div style="margin-top:6px; color:var(--text-muted);">Response: "${s.responseText}"</div>
        </div>`;
      }
      return `<div class="detail-item ${s.status === 'pending_review' ? 'pending' : 'right'}">
        <strong>Short answer${s.status === 'pending_review' ? ' — pending review' : ` — scored ${s.autoScore}%`}</strong><br>${s.prompt}
        <div style="margin-top:6px; color:var(--text-muted);">Response: "${s.responseText}"</div>
      </div>`;
    }).join('') || '<p class="empty">No submissions yet.</p>';

    drawer.innerHTML = `<button class="close" id="closeDrawer">✕</button><h3>${studentName} — ${topicName}</h3>${html}`;
    document.getElementById('closeDrawer').onclick = () => overlay.classList.remove('open');
    overlay.classList.add('open');
  }
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('open'); };

  async function loadQAQueue() {
    const rows = await (await fetch('/api/instructor/pending-qa', { headers: H })).json();
    if (!rows.length) { qaQueue.innerHTML = '<p class="empty">Nothing waiting on review.</p>'; return; }
    qaQueue.innerHTML = rows.map(r => `
      <div class="qa-item" data-id="${r.id}">
        <div class="qa-meta">${r.studentName} · ${r.topicName}</div>
        <div class="qa-prompt">${r.prompt}</div>
        <div class="qa-response">${r.response_text || '(no answer given)'}</div>
        <div class="qa-grade">
          <input type="number" min="0" max="100" placeholder="0-100" id="score-${r.id}">
          <button data-id="${r.id}">Save grade</button>
        </div>
      </div>
    `).join('');
    qaQueue.querySelectorAll('.qa-grade button').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const score = document.getElementById('score-' + id).value;
        if (score === '') return;
        await fetch('/api/instructor/review', { method: 'POST', headers: H, body: JSON.stringify({ submissionId: Number(id), score: Number(score) }) });
        loadQAQueue();
      };
    });
  }

  document.getElementById('exportCsvBtn').onclick = () => {
    if (!lastHeatmapData || !lastHeatmapData.students.length) { showToast('Nothing to export yet.', 'warn'); return; }
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Student', ...lastHeatmapData.topics.map(t => t.name)]];
    lastHeatmapData.students.forEach(s => {
      rows.push([s.name, ...lastHeatmapData.topics.map(t => (s.scores[t.key] == null ? '' : s.scores[t.key]))]);
    });
    const csv = rows.map(r => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mastery-pulse-heatmap-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Heatmap exported as CSV.', 'good');
  };

  async function loadMisconceptions() {
    const rows = await (await fetch('/api/instructor/misconceptions', { headers: H })).json();
    const board = document.getElementById('misconceptionBoard');
    if (!rows.length) { board.innerHTML = '<p class="empty">No misconceptions recorded yet.</p>'; return; }
    board.innerHTML = rows.map((r, i) => `
      <div class="leaderboard-item">
        <span class="rank">#${i + 1}</span>
        <span class="tag-name">${r.tag.replace(/-/g, ' ')}</span>
        <span class="topic-name">${r.topicName}</span>
        <span class="count">${r.n} student${r.n === 1 ? '' : 's'}</span>
      </div>
    `).join('');
  }

  async function loadRemediationImpact() {
    const rows = await (await fetch('/api/instructor/remediation-impact', { headers: H })).json();
    const el = document.getElementById('remediationImpact');
    if (!rows.length) { el.innerHTML = '<p class="empty">No remediations sent yet.</p>'; return; }
    el.innerHTML = rows.map(r => {
      const known = r.beforeAvg != null && r.afterAvg != null;
      const delta = known ? r.afterAvg - r.beforeAvg : null;
      const deltaLabel = !known ? 'awaiting new submissions' : `${delta > 0 ? '+' : ''}${delta} pts since`;
      const deltaClass = !known ? '' : delta > 0 ? 'good' : delta < 0 ? 'bad' : '';
      const when = new Date(r.createdAt + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div class="impact-item">
        <div><strong>${r.topicName}</strong> <span class="time">sent ${when}</span></div>
        <div class="impact-numbers">
          <span>${r.beforeAvg == null ? '—' : r.beforeAvg + '%'} → ${r.afterAvg == null ? '—' : r.afterAvg + '%'}</span>
          <span class="delta ${deltaClass}">${deltaLabel}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ---- live presence: students currently mid-exam, before they've submitted ----
  const activeByStudent = new Map(); // studentId -> {studentName, topicName, answered, total}

  function renderPresenceChips() {
    if (activeByStudent.size === 0) { activeChipsEl.innerHTML = ''; return; }
    activeChipsEl.innerHTML = [...activeByStudent.values()].map(p => {
      const pct = p.total ? Math.round((p.answered / p.total) * 100) : 0;
      // Quiz items are graded server-side the instant they're picked, so this
      // trail shows correct/incorrect live — before the student ever submits.
      const trail = (p.quizTrail || []).map(q => `<span class="trail-dot ${q.correct ? 'good' : 'bad'}" title="${q.correct ? 'Correct' : 'Incorrect'}"></span>`).join('');
      return `<span class="presence-chip"><span class="dot"></span>${p.studentName} — ${p.topicName} (${p.answered}/${p.total})
        <span class="bar"><span style="width:${pct}%"></span></span>${trail ? `<span class="trail">${trail}</span>` : ''}</span>`;
    }).join(' ');
  }

  // ---- socket wiring ----
  const socket = io({ auth: { token } });
  attachLiveBadge(socket);

  socket.on('presence:online', ({ count }) => { onlineCountEl.textContent = count; });

  socket.on('presence:progress', (p) => {
    activeByStudent.set(p.studentId, p);
    renderPresenceChips();
  });

  socket.on('presence:clear', ({ studentId }) => {
    activeByStudent.delete(studentId);
    renderPresenceChips();
  });

  socket.on('exam:submitted', (payload) => {
    showToast(`${payload.studentName} submitted ${payload.topicName} — ${payload.score}%${payload.pendingQA ? ` (${payload.pendingQA} pending review)` : ''}`, 'good');
    pushFeedItem(`<span>🟢 <strong>${payload.studentName}</strong> submitted <strong>${payload.topicName}</strong> — scored ${payload.score}%</span><span class="time">${timeLabel(payload.ts)}</span>`);
    playBeep(880, 0.12);
    flashEventBar('var(--good)');
    loadHeatmap(payload.studentId + ':' + payload.topicKey);
    loadMisconceptions();
    loadRemediationImpact();
    if (payload.pendingQA) loadQAQueue();
  });

  socket.on('qa:reviewed', (payload) => {
    showToast(`Graded ${payload.studentName}'s ${payload.topicName} Q&A — ${payload.score}%`, 'warn');
    pushFeedItem(`<span>📝 Graded <strong>${payload.studentName}</strong>'s ${payload.topicName} short answer — ${payload.score}%</span><span class="time">${timeLabel()}</span>`);
    playBeep(660, 0.15);
    flashEventBar('var(--warn)');
    loadHeatmap(payload.userId + ':' + payload.topicKey);
    loadRemediationImpact();
    loadQAQueue();
  });

  async function loadPresenceSnapshot() {
    const snap = await (await fetch('/api/instructor/presence', { headers: H })).json();
    onlineCountEl.textContent = snap.online;
    snap.active.forEach(p => activeByStudent.set(p.studentId, p));
    renderPresenceChips();
  }

  loadHeatmap();
  loadQAQueue();
  loadMisconceptions();
  loadRemediationImpact();
  loadPresenceSnapshot();
})();
