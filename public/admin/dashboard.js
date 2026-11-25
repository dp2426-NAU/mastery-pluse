(function () {
  const token = sessionStorage.getItem('mp_token');
  const me = JSON.parse(sessionStorage.getItem('mp_user') || 'null');
  if (!token || !me || me.role !== 'admin') { window.location.href = '/admin/login.html'; return; }

  document.getElementById('whoami').textContent = me.name;
  document.getElementById('logoutBtn').onclick = () => {
    sessionStorage.removeItem('mp_token'); sessionStorage.removeItem('mp_user');
    window.location.href = '/admin/login.html';
  };

  const view = document.getElementById('view');
  const dlg = document.getElementById('dlg');
  const nav = document.getElementById('nav');
  const ROLE_LABEL = { student: 'Student', instructor: 'Instructor', admin: 'Administrator' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // SQLite stores UTC without a zone marker.
  const when = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

  async function api(method, path, body) {
    const res = await fetch('/api/admin' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }
  const warn = (e) => showToast(e.message, 'warn');

  // ---- dialogs ----
  const closeDialog = () => dlg.close();

  function confirmDialog(title, message, label, danger) {
    return new Promise((resolve) => {
      dlg.innerHTML = `
        <h2>${esc(title)}</h2><p>${esc(message)}</p>
        <div class="dlg-actions">
          <button class="btn ghost" data-no>Cancel</button>
          <button class="btn ${danger ? 'danger' : ''}" data-yes>${esc(label)}</button>
        </div>`;
      let answer = false;
      dlg.querySelector('[data-no]').onclick = closeDialog;
      dlg.querySelector('[data-yes]').onclick = () => { answer = true; closeDialog(); };
      dlg.addEventListener('close', () => resolve(answer), { once: true });
      dlg.showModal();
    });
  }

  function showPassword(username, password) {
    dlg.innerHTML = `
      <h2>Password for ${esc(username)}</h2>
      <p>Copy it now and share it with them privately. It won't be shown again.</p>
      <div class="secret">${esc(password)}</div>
      <div class="dlg-actions"><button class="btn ghost" data-copy>Copy</button><button class="btn" data-done>Done</button></div>`;
    dlg.querySelector('[data-copy]').onclick = async (e) => {
      try { await navigator.clipboard.writeText(password); e.target.textContent = 'Copied'; }
      catch (err) { showToast('Copy failed. Select the password and copy it manually.', 'warn'); }
    };
    dlg.querySelector('[data-done]').onclick = closeDialog;
    if (!dlg.open) dlg.showModal();
  }

  function userForm(user) {
    const isSelf = user && user.id === me.id;
    dlg.innerHTML = `
      <form id="userForm">
        <h2>${user ? 'Edit ' + esc(user.username) : 'Create account'}</h2>
        <label for="f-name">Full name</label>
        <input id="f-name" required minlength="2" maxlength="60" value="${esc(user ? user.name : '')}">
        ${user ? '' : `
          <label for="f-username">Username</label>
          <input id="f-username" required autocomplete="off" maxlength="32">`}
        <label for="f-role">Role</label>
        <select id="f-role" ${isSelf ? 'disabled' : ''}>
          ${Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${(user ? user.role : 'student') === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
        </select>
        ${user ? '' : `
          <label for="f-pass">Password (leave blank to generate one)</label>
          <input id="f-pass" type="password" autocomplete="new-password" minlength="8">`}
        <p class="error" id="f-err" role="alert"></p>
        <div class="dlg-actions">
          <button type="button" class="btn ghost" data-no>Cancel</button>
          <button type="submit" class="btn">${user ? 'Save changes' : 'Create account'}</button>
        </div>
      </form>`;
    dlg.querySelector('[data-no]').onclick = closeDialog;
    const val = (id) => document.getElementById(id).value;
    dlg.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const submit = dlg.querySelector('[type=submit]');
      submit.disabled = true;
      try {
        if (user) {
          await api('PATCH', '/users/' + user.id, { name: val('f-name'), role: val('f-role') });
          closeDialog();
          showToast('Account updated.', 'good');
        } else {
          const username = val('f-username');
          const out = await api('POST', '/users', {
            name: val('f-name'), username, role: val('f-role'), password: val('f-pass') || undefined,
          });
          showToast(`${ROLE_LABEL[out.user.role]} account created for ${out.user.name}.`, 'good');
          if (out.generatedPassword) showPassword(out.user.username, out.generatedPassword);
          else closeDialog();
        }
        tabs.users();
      } catch (err) {
        document.getElementById('f-err').textContent = err.message;
        submit.disabled = false;
      }
    };
    dlg.showModal();
  }

  // ---- tabs ----
  const filters = { q: '', role: '', status: '' };
  let current = 'overview';
  // A slow response must not draw over a tab the admin has since left.
  async function load(tab, ...paths) {
    const data = await Promise.all(paths.map((p) => api('GET', p)));
    return current === tab ? data : null;
  }

  function auditTable(rows) {
    if (!rows.length) return '<div class="table-wrap"><p class="empty">No changes recorded yet.</p></div>';
    return `<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Administrator</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="when">${when(r.ts)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  const tabs = {
    async overview() {
      const got = await load('overview', '/overview', '/audit');
      if (!got) return;
      const [o, log] = got;
      const tile = (n, label, live) => `<div class="stat-tile ${live ? 'live' : ''}"><div class="num">${n}</div><div class="label">${label}</div></div>`;
      const s = o.settings;
      const access = (on) => `<span class="status ${on ? '' : 'off'}">${on ? 'Open' : 'Closed'}</span>`;
      const up = `${Math.floor(o.uptimeSeconds / 3600)}h ${Math.floor(o.uptimeSeconds / 60) % 60}m`;
      view.innerHTML = `
        <h1>Overview</h1><p class="sub">Accounts, access and activity at a glance.</p>
        <div class="stat-strip">
          ${tile(o.counts.student, 'Students')}${tile(o.counts.instructor, 'Instructors')}${tile(o.counts.admin, 'Administrators')}
          ${tile(o.disabled, 'Disabled accounts')}${tile(o.studentsOnline, 'Students online', true)}${tile(o.activeExams, 'Exams in progress', true)}
        </div>
        <div class="two">
          <div class="panel"><h2>Access</h2>
            <div class="row"><span class="t">Student sign-in</span>${access(s.studentLoginEnabled && !s.maintenanceMode)}</div>
            <div class="row"><span class="t">Instructor sign-in</span>${access(s.instructorLoginEnabled && !s.maintenanceMode)}</div>
            <div class="row"><span class="t">Maintenance mode</span><span>${s.maintenanceMode ? 'On' : 'Off'}</span></div>
          </div>
          <div class="panel"><h2>Activity</h2>
            <div class="row"><span class="t">Exams submitted</span><span>${o.submissions}</span></div>
            <div class="row"><span class="t">Answers awaiting review</span><span>${o.pendingQA}</span></div>
            <div class="row"><span class="t">Server uptime</span><span>${up}</span></div>
          </div>
        </div>
        <h2>Recent changes</h2>${auditTable(log.slice(0, 6))}`;
    },

    async users() {
      const got = await load('users', '/users');
      if (!got) return;
      const [users] = got;
      view.innerHTML = `
        <div class="head">
          <div><h1>User accounts</h1><p class="sub">Create accounts, assign roles, and control who can sign in. Changes apply immediately, even to people already signed in.</p></div>
          <button class="btn" id="addUser">Create account</button>
        </div>
        <div class="filters">
          <input id="q" type="search" placeholder="Search name or username" aria-label="Search accounts" value="${esc(filters.q)}">
          <select id="fRole" aria-label="Filter by role"><option value="">All roles</option>${Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${filters.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
          <select id="fStatus" aria-label="Filter by status"><option value="">Any status</option><option value="on" ${filters.status === 'on' ? 'selected' : ''}>Active</option><option value="off" ${filters.status === 'off' ? 'selected' : ''}>Disabled</option></select>
        </div>
        <div class="table-wrap" id="rows"></div>`;
      const rowsEl = document.getElementById('rows');

      function draw() {
        const q = filters.q.trim().toLowerCase();
        const shown = users.filter((u) => (!q || (u.name + ' ' + u.username).toLowerCase().includes(q))
          && (!filters.role || u.role === filters.role)
          && (!filters.status || u.active === (filters.status === 'on')));
        if (!shown.length) { rowsEl.innerHTML = '<p class="empty">No accounts match these filters.</p>'; return; }
        rowsEl.innerHTML = `<table>
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${shown.map((u) => {
            const self = u.id === me.id ? 'disabled title="You can\'t do this to your own account"' : '';
            return `<tr class="${u.active ? '' : 'off'}" data-id="${u.id}">
              <td>${esc(u.name)}<div class="uname">${esc(u.username)}</div></td>
              <td><span class="role-badge ${u.role}">${ROLE_LABEL[u.role]}</span></td>
              <td><span class="status ${u.active ? '' : 'off'}">${u.active ? 'Active' : 'Disabled'}</span></td>
              <td class="when">${when(u.lastLoginAt)}</td>
              <td class="actions">
                <button class="btn small ghost" data-act="edit">Edit</button>
                <button class="btn small ghost" data-act="reset">Reset password</button>
                <button class="btn small ghost" data-act="toggle" ${self}>${u.active ? 'Disable' : 'Enable'}</button>
                <button class="btn small danger" data-act="delete" ${self}>Delete</button>
              </td></tr>`;
          }).join('')}</tbody></table>`;
      }
      draw();

      document.getElementById('addUser').onclick = () => userForm(null);
      [['q', 'q', 'input'], ['fRole', 'role', 'change'], ['fStatus', 'status', 'change']].forEach(([id, key, ev]) => {
        document.getElementById(id).addEventListener(ev, (e) => { filters[key] = e.target.value; draw(); });
      });
      rowsEl.onclick = async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const u = users.find((x) => x.id === Number(btn.closest('tr').dataset.id));
        try {
          if (btn.dataset.act === 'edit') { userForm(u); return; }
          if (btn.dataset.act === 'reset') {
            const text = u.id === me.id ? 'This signs you out. Copy the new password before closing the next window.' : 'They will be signed out and will need the new password.';
            if (!await confirmDialog(`Reset password for ${u.name}?`, text, 'Reset password')) return;
            const out = await api('POST', `/users/${u.id}/reset-password`, {});
            showPassword(u.username, out.generatedPassword);
            return;
          }
          if (btn.dataset.act === 'toggle') {
            if (u.active && !await confirmDialog(`Disable ${u.name}?`, 'They will be signed out now and can\'t sign in until you enable the account again. Their records are kept.', 'Disable account', true)) return;
            await api('PATCH', '/users/' + u.id, { active: !u.active });
            showToast(`${u.name} ${u.active ? 'disabled' : 'enabled'}.`, 'good');
          }
          if (btn.dataset.act === 'delete') {
            if (!await confirmDialog(`Delete ${u.name}?`, 'This permanently removes the account.', 'Delete account', true)) return;
            await api('DELETE', '/users/' + u.id);
            showToast(`${u.name} deleted.`, 'good');
          }
          tabs.users();
        } catch (err) { warn(err); }
      };
    },

    async permissions() {
      const got = await load('permissions', '/permissions');
      if (!got) return;
      const [perms] = got;
      const group = (role) => `<div class="panel"><h2>${ROLE_LABEL[role]}</h2>${perms.filter((p) => p.role === role).map((p) => `
        <div class="row"><label class="t" for="${p.key}">${esc(p.label)}</label><input type="checkbox" role="switch" class="switch" id="${p.key}" data-key="${p.key}" ${p.allowed ? 'checked' : ''}></div>`).join('')}</div>`;
      const fixed = ['Manage accounts', 'Assign roles', 'Change permissions', 'Change system settings', 'View audit log'];
      view.innerHTML = `
        <h1>Roles &amp; permissions</h1><p class="sub">Choose what each role can do. The server enforces these the moment you change them. To change a person's role, edit their account.</p>
        ${group('student')}${group('instructor')}
        <div class="panel"><h2>Administrator</h2><p class="sub">Always on, so administrators can't lock themselves out.</p>${fixed.map((f) => `
          <div class="row"><span class="t">${f}</span><input type="checkbox" class="switch" checked disabled aria-label="${f}"></div>`).join('')}</div>`;
      view.querySelectorAll('[data-key]').forEach((box) => {
        box.onchange = async () => {
          try {
            await api('PUT', '/permissions', { key: box.dataset.key, allowed: box.checked });
            showToast('Permission updated.', 'good');
          } catch (err) { box.checked = !box.checked; warn(err); }
        };
      });
    },

    async settings() {
      const got = await load('settings', '/settings');
      if (!got) return;
      const [s] = got;
      const sw = (key, t, d) => `<div class="row"><div><label class="t" for="${key}">${t}</label><div class="d">${d}</div></div><input type="checkbox" role="switch" class="switch" id="${key}" ${s[key] ? 'checked' : ''}></div>`;
      const num = (key, t, d, min, max) => `<div class="row"><div><label class="t" for="${key}">${t}</label><div class="d">${d}</div></div><input type="number" id="${key}" min="${min}" max="${max}" required value="${s[key]}"></div>`;
      view.innerHTML = `
        <h1>System settings</h1><p class="sub">Changes apply when you save.</p>
        <form id="settingsForm">
          <div class="panel"><h2>Access</h2>
            ${sw('studentLoginEnabled', 'Student sign-in', 'Turn off to stop new student sign-ins. Students already signed in stay in.')}
            ${sw('instructorLoginEnabled', 'Instructor sign-in', 'Turn off to stop new instructor sign-ins.')}
            ${sw('maintenanceMode', 'Maintenance mode', 'Blocks everyone except administrators. Exams in progress can still be submitted.')}
            ${num('sessionHours', 'Session length (hours)', 'How long a sign-in lasts. Applies to new sign-ins.', 1, 24)}
          </div>
          <div class="panel"><h2>Exams</h2>
            ${num('secondsPerQuestion', 'Seconds per question', 'Sets the exam timer. Every exam gets at least 4 minutes.', 15, 600)}
            ${sw('webcamMonitoring', 'Webcam monitoring', 'Offer camera-based attention monitoring when an exam starts.')}
          </div>
          <div class="panel"><h2>Announcement</h2>
            <div class="row stack"><label class="d" for="announcement">Shown at the top of every page. Leave blank to hide it.</label><textarea id="announcement" maxlength="300">${esc(s.announcement)}</textarea></div>
          </div>
          <button class="btn" type="submit">Save settings</button>
        </form>`;
      document.getElementById('settingsForm').onsubmit = async (e) => {
        e.preventDefault();
        const next = {};
        Object.keys(s).forEach((k) => {
          const el = document.getElementById(k);
          next[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        });
        if (next.maintenanceMode && !s.maintenanceMode
          && !await confirmDialog('Turn on maintenance mode?', 'Students and instructors will be blocked until you turn it off.', 'Turn on', true)) return;
        try {
          Object.assign(s, await api('PUT', '/settings', next));
          showToast('Settings saved.', 'good');
        } catch (err) { warn(err); }
      };
    },

    async audit() {
      const got = await load('audit', '/audit');
      if (!got) return;
      view.innerHTML = `<h1>Audit log</h1><p class="sub">The 100 most recent administrator changes, newest first.</p>${auditTable(got[0])}`;
    },
  };

  function show(tab) {
    current = tabs[tab] ? tab : 'overview';
    nav.querySelectorAll('button').forEach((b) => {
      if (b.dataset.tab === current) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    tabs[current]().catch((e) => { warn(e); });
  }
  nav.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) window.location.hash = b.dataset.tab;
  };
  window.addEventListener('hashchange', () => show(window.location.hash.slice(1)));

  const socket = io({ auth: { token } });
  attachLiveBadge(socket);
  socket.on('presence:online', () => { if (current === 'overview') show('overview'); });
  show(window.location.hash.slice(1));
})();
