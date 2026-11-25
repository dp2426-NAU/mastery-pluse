const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { getSettings } = require('./settings');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-before-real-deploy';

function login(username, password, expectedRole) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { error: 'Invalid username or password.' };
  if (user.role !== expectedRole) return { error: `This login is for ${expectedRole}s only.` };
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return { error: 'Invalid username or password.' };

  if (!user.active) return { error: 'This account has been disabled. Contact your administrator.' };

  // Administrators can always get in, so they can undo any of these.
  const settings = getSettings();
  if (user.role !== 'admin' && settings.maintenanceMode) return { error: 'The system is down for maintenance. Please try again later.' };
  if (user.role === 'student' && !settings.studentLoginEnabled) return { error: 'Student sign-in is currently turned off.' };
  if (user.role === 'instructor' && !settings.instructorLoginEnabled) return { error: 'Instructor sign-in is currently turned off.' };

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const token = jwt.sign(
    { tv: user.token_version, sub: user.id, username: user.username, role: user.role, name: user.display_name },
    JWT_SECRET,
    { expiresIn: settings.sessionHours * 3600 }
  );
  return { token, user: { id: user.id, username: user.username, role: user.role, name: user.display_name } };
}

function verifyToken(token) {
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    // A valid signature isn't enough: the account must still exist, be
    // active, hold the same role, and not have had its sessions revoked.
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.sub);
    if (!user || !user.active || user.username !== claims.username
      || user.role !== claims.role || user.token_version !== claims.tv) return null;
    return { ...claims, name: user.display_name };
  } catch (e) {
    return null;
  }
}

// Express middleware: requires a valid token for the given role.
function requireRole(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token;
    const claims = token && verifyToken(token);
    if (!claims || claims.role !== role) {
      return res.status(403).json({
        error: 'Forbidden: wrong role or invalid session.',
        code: claims ? 'WRONG_ROLE' : 'SESSION_INVALID',
      });
    }
    // Submitting stays open so maintenance never costs a student their answers.
    if (role !== 'admin' && !(req.path || '').endsWith('/submit') && getSettings().maintenanceMode) {
      return res.status(503).json({ error: 'The system is down for maintenance.', code: 'MAINTENANCE' });
    }
    req.user = claims;
    next();
  };
}

module.exports = { login, verifyToken, requireRole, JWT_SECRET };
