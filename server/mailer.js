// Sends the instructor a real email the moment a webcam attention alert
// crosses its 3-strike threshold. Talks to Resend's plain HTTP API with
// Node's built-in fetch — no SDK dependency to install.
//
// Degrades on purpose, never throws into the caller: if RESEND_API_KEY or
// ALERT_TO_EMAIL isn't set (e.g. a student running this locally without
// ever configuring email), this just no-ops and logs why. Dashboard alerts
// still work either way — email is an addition, not a requirement.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function config() {
  return {
    apiKey: process.env.RESEND_API_KEY,
    to: process.env.ALERT_TO_EMAIL,
    from: process.env.ALERT_FROM_EMAIL || 'Mastery Pulse <onboarding@resend.dev>',
  };
}

async function sendWebcamAlertEmail({ studentName, topicName, count, ts, snapshotDataUrl }) {
  // Never actually calls the network under the test suite — same escape
  // hatch pattern as the rate limiters (NODE_ENV=test is set by Jest itself).
  if (process.env.NODE_ENV === 'test') return { skipped: 'test' };

  const { apiKey, to, from } = config();
  if (!apiKey || !to) return { skipped: 'email alerts not configured (RESEND_API_KEY / ALERT_TO_EMAIL)' };

  const when = new Date(ts || Date.now()).toLocaleString();
  const attachments = [];
  if (typeof snapshotDataUrl === 'string' && snapshotDataUrl.startsWith('data:image/')) {
    const base64 = snapshotDataUrl.split(',')[1];
    if (base64) attachments.push({ filename: 'proctoring-flag.jpg', content: base64 });
  }

  const payload = {
    from,
    to: [to],
    subject: `Proctoring alert: ${studentName} — ${topicName}`,
    html: `
      <p><strong>${studentName}</strong> triggered ${count} webcam attention alert${count === 1 ? '' : 's'} during the <strong>${topicName}</strong> exam.</p>
      <p>Time: ${when}</p>
      <p style="color:#666;font-size:13px;">This is a browser-side head-pose / eye-closure estimate, not proof of anything — lighting and camera angle affect it. Treat it as a signal to review, alongside the dashboard's integrity trail, not a verdict.</p>
    `,
    attachments,
  };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Resend email send failed:', res.status, text);
      return { error: true, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    console.log(`Webcam alert email queued via Resend for ${to} (id: ${body.id || 'unknown'})`);
    return { ok: true };
  } catch (err) {
    console.error('Resend email send error:', err.message);
    return { error: true, message: err.message };
  }
}

module.exports = { sendWebcamAlertEmail };
