(function () {
  const token = localStorage.getItem('mp_token');
  const user = JSON.parse(localStorage.getItem('mp_user') || 'null');
  if (!token || !user || user.role !== 'instructor') { window.location.href = '/instructor/login.html'; return; }

  document.getElementById('whoami').textContent = user.name;
  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('mp_token'); localStorage.removeItem('mp_user');
    window.location.href = '/instructor/login.html';
  };

  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const heatmapArea = document.getElementById('heatmapArea');
  const qaQueue = document.getElementById('qaQueue');
  const overlay = document.getElementById('overlay');
  const drawer = document.getElementById('drawer');

  function band(score) {
    if (score == null) return 'none';
    if (score < 50) return 'low';
    if (score < 75) return 'mid';
    return 'high';
  }

  async function loadHeatmap() {
    const data = await (await fetch('/api/instructor/heatmap', { headers: H })).json();
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
    data.students.forEach(s => {
      html += `<tr><td>${s.name}</td>`;
      data.topics.forEach(t => {
        const score = s.scores[t.key];
        html += `<td><span class="cell ${band(score)}" data-student="${s.id}" data-topic="${t.key}" data-name="${s.name}" data-topicname="${t.name}">${score == null ? '—' : score + '%'}</span></td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    heatmapArea.innerHTML = html;

    heatmapArea.querySelectorAll('.cell:not(.none)').forEach(cell => {
      cell.onclick = () => openDetail(cell.dataset.student, cell.dataset.topic, cell.dataset.name, cell.dataset.topicname);
    });
    heatmapArea.querySelectorAll('.remediate-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        btn.textContent = 'Sending…';
        await fetch('/api/instructor/remediate', { method: 'POST', headers: H, body: JSON.stringify({ topicKey: btn.dataset.topic }) });
        btn.textContent = 'Sent ✓';
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
        loadHeatmap();
      };
    });
  }

  const socket = io({ auth: { token } });
  socket.on('exam:submitted', () => { loadHeatmap(); loadQAQueue(); });
  socket.on('qa:reviewed', () => { loadHeatmap(); loadQAQueue(); });

  loadHeatmap();
  loadQAQueue();
})();
