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
