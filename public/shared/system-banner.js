// Shows the administrator's announcement or a maintenance notice at the top
// of any page, and on login pages explains why a session just ended.
(function () {
  const banner = document.createElement('div');
  banner.className = 'system-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  document.body.prepend(banner);

  window.refreshSystemBanner = async function refreshSystemBanner() {
    try {
      const s = await (await fetch('/api/system/status')).json();
      const text = [s.maintenanceMode && 'The system is down for maintenance.', s.announcement].filter(Boolean).join(' ');
      banner.textContent = text;
      banner.hidden = !text;
    } catch (e) { /* the banner is optional; never break the page over it */ }
  };
  window.refreshSystemBanner();

  const err = document.getElementById('err');
  const notice = sessionStorage.getItem('mp_notice');
  if (err && notice) {
    err.textContent = notice;
    sessionStorage.removeItem('mp_notice');
  }
})();
