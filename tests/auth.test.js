process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

require('../server/seed');
const { login, verifyToken, requireRole } = require('../server/auth');

describe('login', () => {
  test('correct student credentials return a token carrying role=student', () => {
    const result = login('student1', 'Pulse#Student1', 'student');
    expect(result.token).toBeDefined();
    const claims = verifyToken(result.token);
    expect(claims.role).toBe('student');
    expect(claims.username).toBe('student1');
  });

  test('a wrong password is rejected without issuing a token', () => {
    const result = login('student1', 'wrong-password', 'student');
    expect(result.error).toBeDefined();
    expect(result.token).toBeUndefined();
  });

  test('a real student cannot obtain a token through the instructor login route', () => {
    const result = login('student1', 'Pulse#Student1', 'instructor');
    expect(result.error).toMatch(/instructors only/i);
    expect(result.token).toBeUndefined();
  });

  test('an unknown username gets the same generic error as a wrong password', () => {
    const result = login('not-a-real-user', 'whatever', 'student');
    expect(result.error).toBe('Invalid username or password.');
  });
});

describe('verifyToken', () => {
  test('rejects a garbage string instead of throwing', () => {
    expect(verifyToken('not-a-real-jwt')).toBeNull();
  });

  test('rejects a token signed with a different secret', () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 1, role: 'instructor' }, 'a-different-secret');
    expect(verifyToken(forged)).toBeNull();
  });
});

describe('requireRole middleware', () => {
  function mockReqRes(token) {
    const req = { headers: token ? { authorization: 'Bearer ' + token } : {}, cookies: {} };
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    return { req, res };
  }

  test('rejects a request with no token at all', () => {
    const { req, res } = mockReqRes(null);
    const next = jest.fn();
    requireRole('student')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an instructor token on a student-only route', () => {
    const { token } = login('prof.demo', 'MasterClass#2026', 'instructor');
    const { req, res } = mockReqRes(token);
    const next = jest.fn();
    requireRole('student')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a student token on an instructor-only route', () => {
    const { token } = login('student1', 'Pulse#Student1', 'student');
    const { req, res } = mockReqRes(token);
    const next = jest.fn();
    requireRole('instructor')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts a matching-role token and attaches the decoded claims as req.user', () => {
    const { token } = login('student1', 'Pulse#Student1', 'student');
    const { req, res } = mockReqRes(token);
    const next = jest.fn();
    requireRole('student')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.role).toBe('student');
    expect(req.user.username).toBe('student1');
  });
});
