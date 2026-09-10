const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-before-real-deploy';
const TOKEN_TTL = '8h';

function login(username, password, expectedRole) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { error: 'Invalid username or password.' };
  if (user.role !== expectedRole) return { error: `This login is for ${expectedRole}s only.` };
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return { error: 'Invalid username or password.' };

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role, name: user.display_name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
  return { token, user: { id: user.id, username: user.username, role: user.role, name: user.display_name } };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
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
      return res.status(403).json({ error: 'Forbidden: wrong role or invalid session.' });
    }
    req.user = claims;
    next();
  };
}

module.exports = { login, verifyToken, requireRole, JWT_SECRET };
