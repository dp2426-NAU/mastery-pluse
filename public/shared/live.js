// Shared real-time UI helpers: toast stack + connection status badge.
// Loaded by both the student and instructor panels, after socket.io.js.
(function () {
  function ensureToastStack() {
    let stack = document.getElementById('toastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toastStack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  // Responses the server sends when an administrator has changed something
  // under a signed-in user. Handled here so every call site is covered.
  function endSession(reason) {
    const user = JSON.parse(sessionStorage.getItem('mp_user') || 'null');
    sessionStorage.removeItem('mp_token'); sessionStorage.removeItem('mp_user');
    sessionStorage.setItem('mp_notice', reason);
    window.location.href = `/${user ? user.role : 'student'}/login.html`;
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 403 || res.status === 503) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'SESSION_INVALID') endSession('Your session has ended. Please sign in again.');
      else if (body.code) showToast(body.error, 'warn');
    }
    return res;
  };

  window.showToast = function showToast(message, kind) {
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 4200);
  };

  // Attaches a "Live / Reconnecting" badge to the topbar and wires it to socket state.
  window.attachLiveBadge = function attachLiveBadge(socket) {
    const who = document.getElementById('whoami');
    if (!who) return;
    const badge = document.createElement('span');
    badge.id = 'connBadge';
    badge.className = 'conn-badge connecting';
    badge.innerHTML = '<span class="dot"></span>Connecting…';
    who.parentNode.insertBefore(badge, who);

    socket.on('session:revoked', ({ reason }) => endSession(reason));
    socket.on('system:changed', () => { if (window.refreshSystemBanner) window.refreshSystemBanner(); });
    socket.on('connect', () => {
      badge.className = 'conn-badge live';
      badge.innerHTML = '<span class="dot"></span>Live';
    });
    socket.on('disconnect', () => {
      badge.className = 'conn-badge down';
      badge.innerHTML = '<span class="dot"></span>Reconnecting…';
    });
    socket.on('connect_error', () => {
      badge.className = 'conn-badge down';
      badge.innerHTML = '<span class="dot"></span>Offline';
    });
  };
})();
