// Administrator API: accounts, roles, permissions, system settings, audit log.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { requireRole } = require('./auth');
const settings = require('./settings');
const {
  validate, createUserSchema, updateUserSchema, resetPasswordSchema, permissionSchema, settingsSchema,
} = require('./validation');

const publicUser = (u) => ({
  id: u.id, username: u.username, name: u.display_name, role: u.role,
  active: !!u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at,
});

// Unambiguous characters only, so a password read aloud or copied by hand works.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 14 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

module.exports = function createAdminRouter({ io, getLiveCounts }) {
  const router = express.Router();
  router.use(requireRole('admin'));

  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const insertAudit = db.prepare('INSERT INTO audit_log (actor, action, target, detail) VALUES (?, ?, ?, ?)');
  const audit = (req, action, target, detail) => insertAudit.run(req.user.username, action, target || null, detail || null);

  // Ends every open session for a user: existing tokens stop verifying
  // (token_version changed) and live sockets are told why, then closed.
  function revokeSessions(userId, reason) {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
    io.to('user:' + userId).emit('session:revoked', { reason });
    io.in('user:' + userId).disconnectSockets(true);
  }

  function loadUser(req, res, next) {
    req.target = getUser.get(Number(req.params.id));
    if (!req.target) return res.status(404).json({ error: 'Account not found.' });
    next();
  }

  router.get('/overview', (req, res) => {
    const counts = { student: 0, instructor: 0, admin: 0 };
    db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all().forEach((r) => { counts[r.role] = r.n; });
    const one = (sql) => db.prepare(sql).get().n;
    res.json({
      counts,
      disabled: one('SELECT COUNT(*) AS n FROM users WHERE active = 0'),
      submissions: one('SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id, topic_id, exam_run FROM submissions)'),
      pendingQA: one("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending_review'"),
      ...getLiveCounts(),
      uptimeSeconds: Math.round(process.uptime()),
      settings: settings.getSettings(),
    });
  });

  router.get('/users', (req, res) => {
    res.json(db.prepare('SELECT * FROM users ORDER BY role, display_name').all().map(publicUser));
  });

  router.post('/users', validate(createUserSchema), (req, res) => {
    const { username, name, role } = req.body;
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    const password = req.body.password || generatePassword();
    const info = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 10), role, name);
    audit(req, 'Created account', username, `Role: ${role}`);
    res.status(201).json({
      user: publicUser(getUser.get(info.lastInsertRowid)),
      generatedPassword: req.body.password ? undefined : password,
    });
  });

  router.patch('/users/:id', loadUser, validate(updateUserSchema), (req, res) => {
    const before = req.target;
    const name = req.body.name ?? before.display_name;
    const role = req.body.role ?? before.role;
    const active = req.body.active === undefined ? before.active : Number(req.body.active);

    // An admin can't demote or disable themselves, which also guarantees
    // there is always at least one working administrator.
    if (before.id === req.user.sub && (role !== before.role || active !== before.active)) {
      return res.status(400).json({ error: "You can't change your own role or disable your own account." });
    }

    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, before.id);

    if (name !== before.display_name) audit(req, 'Renamed account', before.username, `${before.display_name} → ${name}`);
    if (role !== before.role) audit(req, 'Changed role', before.username, `${before.role} → ${role}`);
    if (active !== before.active) audit(req, active ? 'Enabled account' : 'Disabled account', before.username);
    if (active !== before.active && !active) revokeSessions(before.id, 'Your account was disabled by an administrator.');
    else if (role !== before.role) revokeSessions(before.id, 'Your role was changed by an administrator. Please sign in again.');

    res.json({ user: publicUser(getUser.get(before.id)) });
  });

  router.post('/users/:id/reset-password', loadUser, validate(resetPasswordSchema), (req, res) => {
    const password = req.body.password || generatePassword();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.target.id);
    audit(req, 'Reset password', req.target.username);
    revokeSessions(req.target.id, 'Your password was reset by an administrator. Please sign in again.');
    res.json({ ok: true, generatedPassword: req.body.password ? undefined : password });
  });

  router.delete('/users/:id', loadUser, (req, res) => {
    const u = req.target;
    if (u.id === req.user.sub) return res.status(400).json({ error: "You can't delete your own account." });
    const hasRecords = ['submissions', 'exam_integrity', 'webcam_alerts']
      .some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE user_id = ? LIMIT 1`).get(u.id));
    if (hasRecords) {
      return res.status(409).json({ error: 'This account has exam records, so it cannot be deleted. Disable it instead.' });
    }
    revokeSessions(u.id, 'Your account was removed by an administrator.');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    audit(req, 'Deleted account', u.username, `Role: ${u.role}`);
    res.json({ ok: true });
  });

  router.get('/permissions', (req, res) => res.json(settings.listPermissions()));

  router.put('/permissions', validate(permissionSchema), (req, res) => {
    const perm = settings.PERMISSIONS.find((p) => p.key === req.body.key);
    if (!perm) return res.status(404).json({ error: 'Unknown permission.' });
    settings.setPermission(perm.key, req.body.allowed);
    audit(req, req.body.allowed ? 'Allowed permission' : 'Denied permission', perm.role, perm.label);
    res.json(settings.listPermissions());
  });

  router.get('/settings', (req, res) => res.json(settings.getSettings()));

  router.put('/settings', validate(settingsSchema), (req, res) => {
    const before = settings.getSettings();
    const changed = Object.entries(req.body).filter(([k, v]) => v !== undefined && before[k] !== v);
    if (changed.length) {
      settings.saveSettings(Object.fromEntries(changed));
      changed.forEach(([k, v]) => audit(req, 'Changed setting', k, `${before[k] === '' ? '(empty)' : before[k]} → ${v === '' ? '(empty)' : v}`));
      io.emit('system:changed');
    }
    res.json(settings.getSettings());
  });

  router.get('/audit', (req, res) => {
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all());
  });

  return router;
};
