// Administrator features end to end: real Express app, real database, and
// real sockets for the "applies to people already signed in" guarantees.
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_PASSWORD = 'Admin-test-password';

require('../server/seed');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { app, server } = require('../server/server');

let admin;
let instructor;
let student;

async function login(role, username, password) {
  return request(app).post(`/api/auth/${role}/login`).send({ username, password });
}
const as = (token) => ({
  get: (p) => request(app).get(p).set('Authorization', 'Bearer ' + token),
  post: (p, b) => request(app).post(p).set('Authorization', 'Bearer ' + token).send(b),
  put: (p, b) => request(app).put(p).set('Authorization', 'Bearer ' + token).send(b),
  patch: (p, b) => request(app).patch(p).set('Authorization', 'Bearer ' + token).send(b),
  del: (p) => request(app).delete(p).set('Authorization', 'Bearer ' + token),
});
async function create(username, role = 'student') {
  const res = await admin.post('/api/admin/users', { username, name: 'Test Person', role, password: 'Password-123' });
  expect(res.status).toBe(201);
  return res.body.user;
}

beforeAll(async () => {
  await new Promise((r) => server.listen(0, r));
  admin = as((await login('admin', 'admin.demo', 'Admin-test-password')).body.token);
  instructor = as((await login('instructor', 'prof.demo', 'MasterClass#2026')).body.token);
  student = as((await login('student', 'student1', 'Pulse#Student1')).body.token);
});
afterAll((done) => { server.close(() => done()); });

test('only an administrator can reach /api/admin', async () => {
  for (const path of ['overview', 'users', 'permissions', 'settings', 'audit']) {
    expect((await request(app).get('/api/admin/' + path)).status).toBe(403);
    expect((await student.get('/api/admin/' + path)).status).toBe(403);
    expect((await instructor.get('/api/admin/' + path)).status).toBe(403);
    expect((await admin.get('/api/admin/' + path)).status).toBe(200);
  }
  expect((await login('admin', 'prof.demo', 'MasterClass#2026')).status).toBe(401);
});

describe('accounts', () => {
  test('a new instructor can be created with a generated password and sign in', async () => {
    const res = await admin.post('/api/admin/users', { username: 'New.Prof', name: "Pat O'Neil", role: 'instructor' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('new.prof');
    expect((await login('instructor', 'new.prof', res.body.generatedPassword)).status).toBe(200);
  });

  test('password hashes are never returned', async () => {
    expect(JSON.stringify((await admin.get('/api/admin/users')).body)).not.toMatch(/hash|\$2[ab]\$/);
  });

  test('duplicates, markup in names, weak passwords and unknown fields are refused', async () => {
    const good = { username: 'valid.name', name: 'Valid Name', role: 'student' };
    expect((await admin.post('/api/admin/users', { ...good, username: 'student1' })).status).toBe(409);
    expect((await admin.post('/api/admin/users', { ...good, name: '<img src=x>' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...good, password: 'short' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...good, role: 'root' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { ...good, token_version: 1 })).status).toBe(400);
  });

  test('disabling ends the open session and blocks sign-in; enabling restores it', async () => {
    const u = await create('dis.abled');
    const { token } = (await login('student', 'dis.abled', 'Password-123')).body;
    const socket = ioClient(`http://localhost:${server.address().port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
    await new Promise((r) => socket.on('connect', r));
    const revoked = new Promise((r) => socket.on('session:revoked', r));
    const closed = new Promise((r) => socket.on('disconnect', r));

    await admin.patch('/api/admin/users/' + u.id, { active: false });
    expect((await revoked).reason).toMatch(/disabled/);
    await closed;
    socket.close();

    const res = await as(token).get('/api/student/topics');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_INVALID');
    expect((await login('student', 'dis.abled', 'Password-123')).body.error).toMatch(/disabled/);

    await admin.patch('/api/admin/users/' + u.id, { active: true });
    expect((await as(token).get('/api/student/topics')).status).toBe(403); // the old token stays dead
    expect((await login('student', 'dis.abled', 'Password-123')).status).toBe(200);
  });

  test('changing a role moves the account to the other panel and drops its old token', async () => {
    const u = await create('promo.ted');
    const { token } = (await login('student', 'promo.ted', 'Password-123')).body;
    await admin.patch('/api/admin/users/' + u.id, { role: 'instructor' });
    expect((await as(token).get('/api/student/topics')).status).toBe(403);
    const { body } = await login('instructor', 'promo.ted', 'Password-123');
    expect((await as(body.token).get('/api/instructor/heatmap')).status).toBe(200);
  });

  test('a password reset invalidates the old password and session', async () => {
    const u = await create('re.set');
    const { token } = (await login('student', 're.set', 'Password-123')).body;
    const { generatedPassword } = (await admin.post(`/api/admin/users/${u.id}/reset-password`, {})).body;
    expect((await as(token).get('/api/student/topics')).status).toBe(403);
    expect((await login('student', 're.set', 'Password-123')).status).toBe(401);
    expect((await login('student', 're.set', generatedPassword)).status).toBe(200);
  });

  test('accounts can be deleted only while they have no exam records', async () => {
    const u = await create('gone.soon');
    expect((await admin.del('/api/admin/users/' + u.id)).status).toBe(200);
    expect((await admin.del('/api/admin/users/' + u.id)).status).toBe(404);

    const exam = (await student.get('/api/student/exam/networking')).body;
    await student.post('/api/student/exam/networking/submit', {
      responses: [{ itemId: exam.items[0].id, type: exam.items[0].type, selectedIndex: 0, text: 'x' }],
    });
    const s1 = (await admin.get('/api/admin/users')).body.find((x) => x.username === 'student1');
    expect((await admin.del('/api/admin/users/' + s1.id)).status).toBe(409);
  });

  test('administrators cannot demote, disable or delete themselves', async () => {
    const self = (await admin.get('/api/admin/users')).body.find((x) => x.username === 'admin.demo');
    expect((await admin.patch('/api/admin/users/' + self.id, { active: false })).status).toBe(400);
    expect((await admin.patch('/api/admin/users/' + self.id, { role: 'student' })).status).toBe(400);
    expect((await admin.del('/api/admin/users/' + self.id)).status).toBe(400);
  });
});

test('each permission is enforced by the server and can be restored', async () => {
  const cases = [
    ['student.take_exams', () => student.get('/api/student/exam/networking')],
    ['student.practice', () => student.get('/api/student/remediation/1')],
    ['instructor.review_qa', () => instructor.post('/api/instructor/review', {})],
    ['instructor.remediate', () => instructor.post('/api/instructor/remediate', {})],
    ['instructor.grant_retake', () => instructor.post('/api/instructor/webcam-alerts/1/grant-retake', {})],
  ];
  for (const [key, call] of cases) {
    await admin.put('/api/admin/permissions', { key, allowed: false });
    expect((await call()).body.code).toBe('PERMISSION_DENIED');
    await admin.put('/api/admin/permissions', { key, allowed: true });
    expect((await call()).body.code).toBeUndefined();
  }
  expect((await admin.put('/api/admin/permissions', { key: 'nope', allowed: true })).status).toBe(404);
});

describe('settings', () => {
  test('sign-in switches block only the matching role', async () => {
    await admin.put('/api/admin/settings', { studentLoginEnabled: false });
    expect((await login('student', 'student2', 'Pulse#Student2')).status).toBe(401);
    expect((await login('instructor', 'prof.demo', 'MasterClass#2026')).status).toBe(200);
    await admin.put('/api/admin/settings', { studentLoginEnabled: true, instructorLoginEnabled: false });
    expect((await login('student', 'student2', 'Pulse#Student2')).status).toBe(200);
    expect((await login('instructor', 'prof.demo', 'MasterClass#2026')).status).toBe(401);
    await admin.put('/api/admin/settings', { instructorLoginEnabled: true });
  });

  test('maintenance blocks students and instructors, but not admins or an exam submission', async () => {
    const exam = (await student.get('/api/student/exam/networking')).body;
    await admin.put('/api/admin/settings', { maintenanceMode: true, announcement: 'Back at noon' });
    expect((await student.get('/api/student/topics')).status).toBe(503);
    expect((await instructor.get('/api/instructor/heatmap')).status).toBe(503);
    expect((await login('student', 'student2', 'Pulse#Student2')).status).toBe(401);
    expect((await login('admin', 'admin.demo', 'Admin-test-password')).status).toBe(200);
    expect((await student.post('/api/student/exam/networking/submit', {
      responses: [{ itemId: exam.items[0].id, type: exam.items[0].type, selectedIndex: 0, text: 'x' }],
    })).status).toBe(200);
    expect((await request(app).get('/api/system/status')).body).toEqual({ maintenanceMode: true, announcement: 'Back at noon' });
    await admin.put('/api/admin/settings', { maintenanceMode: false, announcement: '' });
    expect((await student.get('/api/student/topics')).status).toBe(200);
  });

  test('exam timing and webcam settings reach the exam, and bad values are refused', async () => {
    await admin.put('/api/admin/settings', { secondsPerQuestion: 600, webcamMonitoring: false });
    const exam = (await student.get('/api/student/exam/networking')).body;
    expect(exam.timeLimitSeconds).toBe(exam.items.length * 600);
    expect(exam.webcamMonitoring).toBe(false);
    expect((await admin.put('/api/admin/settings', { secondsPerQuestion: 1 })).status).toBe(400);
    expect((await admin.put('/api/admin/settings', { unknown: true })).status).toBe(400);
    await admin.put('/api/admin/settings', { secondsPerQuestion: 90, webcamMonitoring: true });
  });
});

test('changes are written to the audit log without passwords', async () => {
  const { body } = await admin.get('/api/admin/audit');
  const actions = body.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['Created account', 'Changed role', 'Disabled account', 'Reset password', 'Deleted account', 'Denied permission', 'Changed setting']));
  expect(JSON.stringify(body)).not.toContain('Password-123');
});

test('a database from before the admin role is upgraded without losing data', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('student','instructor')), display_name TEXT NOT NULL);
    CREATE TABLE exam_integrity (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), topic_id INTEGER, exam_run INTEGER, events TEXT, created_at TEXT);
    INSERT INTO users VALUES (7, 'kept', 'h', 'student', 'Kept');
    INSERT INTO exam_integrity VALUES (1, 7, 1, 1, '[]', '');
  `);
  old.close();
  execFileSync(process.execPath, [path.join(__dirname, '../server/seed.js')], { env: { ...process.env, DB_PATH: file } });
  const db = new Database(file);
  expect(db.prepare("SELECT id FROM users WHERE username = 'kept'").get().id).toBe(7);
  expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
