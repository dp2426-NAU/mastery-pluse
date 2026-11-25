// System settings and role permissions: the two things an administrator can
// change at runtime. Defaults live in code; the database stores overrides.
const db = require('./db');

const DEFAULTS = {
  maintenanceMode: false,       // blocks everyone except admins
  studentLoginEnabled: true,
  instructorLoginEnabled: true,
  webcamMonitoring: true,       // offer webcam proctoring when an exam starts
  secondsPerQuestion: 90,
  sessionHours: 8,
  announcement: '',             // banner shown on every page
};

// Each permission is enforced on the server, not only hidden in the UI.
const PERMISSIONS = [
  { key: 'student.take_exams', role: 'student', label: 'Start topic exams' },
  { key: 'student.practice', role: 'student', label: 'Use remediation practice' },
  { key: 'instructor.review_qa', role: 'instructor', label: 'Grade Q&A answers' },
  { key: 'instructor.remediate', role: 'instructor', label: 'Send remediation to the class' },
  { key: 'instructor.grant_retake', role: 'instructor', label: 'Grant exam retakes' },
  { key: 'instructor.view_snapshots', role: 'instructor', label: 'View webcam snapshots' },
];

const allSettings = db.prepare('SELECT key, value FROM settings');
const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const getPerm = db.prepare('SELECT allowed FROM permissions WHERE key = ?');
const putPerm = db.prepare('INSERT INTO permissions (key, allowed) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET allowed = excluded.allowed');

function getSettings() {
  const out = { ...DEFAULTS };
  for (const { key, value } of allSettings.all()) {
    if (key in DEFAULTS) out[key] = JSON.parse(value);
  }
  return out;
}

const saveSettings = db.transaction((changes) => {
  for (const [key, value] of Object.entries(changes)) putSetting.run(key, JSON.stringify(value));
});

// Permissions are allowed unless an administrator has switched them off.
function hasPermission(key) {
  const row = getPerm.get(key);
  return row ? !!row.allowed : true;
}

function listPermissions() {
  return PERMISSIONS.map((p) => ({ ...p, allowed: hasPermission(p.key) }));
}

function setPermission(key, allowed) {
  putPerm.run(key, allowed ? 1 : 0);
}

function requirePermission(key) {
  return (req, res, next) => {
    if (hasPermission(key)) return next();
    res.status(403).json({ error: 'An administrator has turned off this feature for your role.', code: 'PERMISSION_DENIED' });
  };
}

module.exports = { PERMISSIONS, getSettings, saveSettings, hasPermission, listPermissions, setPermission, requirePermission };
