// Webcam proctoring alerts: client-side face-detection strikes reported
// over the socket channel, stored, relayed live to the instructor, and
// surfaced on the heatmap/drill-down — same real HTTP server + real
// socket.io-client pattern as tests/realtime.test.js.
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

require('../server/seed');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { app, server } = require('../server/server');

let port;
let studentToken;
let instructorToken;
let student5Token; // isolated from student4's webcam-alert history used by the tests above

beforeAll((done) => {
  server.listen(0, async () => {
    port = server.address().port;
    const s = await request(app).post('/api/auth/student/login').send({ username: 'student4', password: 'Pulse#Student4' });
    studentToken = s.body.token;
    const s5 = await request(app).post('/api/auth/student/login').send({ username: 'student5', password: 'Pulse#Student5' });
    student5Token = s5.body.token;
    const i = await request(app).post('/api/auth/instructor/login').send({ username: 'prof.demo', password: 'MasterClass#2026' });
    instructorToken = i.body.token;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

function connect(token) {
  return ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
}

const TINY_SNAPSHOT = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('a 3rd-strike webcam alert reaches the instructor live and is stored', (done) => {
  const instrSocket = connect(instructorToken);
  const studSocket = connect(studentToken);

  Promise.all([
    new Promise((r) => instrSocket.on('connect', r)),
    new Promise((r) => studSocket.on('connect', r)),
  ]).then(() => {
    instrSocket.on('integrity:webcamAlert', async (payload) => {
      expect(payload.studentName).toBe('Wei Zhang');
      expect(payload.topicName).toBe('Web Technology');
      expect(payload.count).toBe(3);
      expect(payload.snapshot).toBe(TINY_SNAPSHOT);

      const rows = await request(app).get('/api/instructor/webcam-alerts').set('Authorization', 'Bearer ' + instructorToken);
      const row = rows.body.find((r) => r.studentName === 'Wei Zhang' && r.topicKey === 'web-technology');
      expect(row).toBeDefined();
      expect(row.count).toBe(3);

      const heatmap = await request(app).get('/api/instructor/heatmap').set('Authorization', 'Bearer ' + instructorToken);
      const student = heatmap.body.students.find((s) => s.name === 'Wei Zhang');
      expect(student.webcamFlagged['web-technology']).toBe(true);

      const detail = await request(app).get(`/api/instructor/detail/${student.id}/web-technology`).set('Authorization', 'Bearer ' + instructorToken);
      expect(detail.body.webcamAlerts.length).toBeGreaterThan(0);
      expect(detail.body.webcamAlerts[0].count).toBe(3);

      instrSocket.close();
      studSocket.close();
      done();
    });

    studSocket.emit('exam:start', { topicKey: 'web-technology', topicName: 'Web Technology', total: 5 });
    studSocket.emit('exam:webcamAlert', { topicKey: 'web-technology', count: 3, snapshot: TINY_SNAPSHOT });
  });
}, 10000);

test('a strike count below 3 is ignored — no row stored, nothing relayed', (done) => {
  const instrSocket = connect(instructorToken);
  const studSocket = connect(studentToken);
  let heardAlert = false;

  instrSocket.on('integrity:webcamAlert', () => { heardAlert = true; });

  Promise.all([
    new Promise((r) => instrSocket.on('connect', r)),
    new Promise((r) => studSocket.on('connect', r)),
  ]).then(() => {
    studSocket.emit('exam:start', { topicKey: 'cloud-computing', topicName: 'Cloud Computing', total: 5 });
    studSocket.emit('exam:webcamAlert', { topicKey: 'cloud-computing', count: 1, snapshot: TINY_SNAPSHOT });

    setTimeout(async () => {
      expect(heardAlert).toBe(false);
      const rows = await request(app).get('/api/instructor/webcam-alerts').set('Authorization', 'Bearer ' + instructorToken);
      expect(rows.body.some((r) => r.topicKey === 'cloud-computing' && r.studentName === 'Wei Zhang')).toBe(false);
      instrSocket.close();
      studSocket.close();
      done();
    }, 300);
  });
}, 10000);

test('an oversized snapshot payload is dropped, but the strike is still recorded', (done) => {
  const instrSocket = connect(instructorToken);
  const studSocket = connect(studentToken);
  const hugeSnapshot = 'data:image/jpeg;base64,' + 'A'.repeat(400000);

  Promise.all([
    new Promise((r) => instrSocket.on('connect', r)),
    new Promise((r) => studSocket.on('connect', r)),
  ]).then(() => {
    instrSocket.on('integrity:webcamAlert', (payload) => {
      expect(payload.snapshot).toBeNull();
      instrSocket.close();
      studSocket.close();
      done();
    });
    studSocket.emit('exam:start', { topicKey: 'networking', topicName: 'Networking', total: 5 });
    studSocket.emit('exam:webcamAlert', { topicKey: 'networking', count: 4, snapshot: hugeSnapshot });
  });
}, 10000);

describe('forcedFail submit — the 3rd strike ends the exam as a hard fail', () => {
  function submitForced(token, topicKey, extraQaText) {
    return async () => {
      const examRes = await request(app).get('/api/student/exam/' + topicKey).set('Authorization', 'Bearer ' + token);
      const responses = examRes.body.items.map((it) => it.type === 'quiz'
        ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 } // may well be correct
        : { itemId: it.id, type: it.type, text: extraQaText || 'a normal response', confidence: 3 });
      return request(app).post(`/api/student/exam/${topicKey}/submit`).set('Authorization', 'Bearer ' + token)
        .send({ responses, forcedFail: true });
    };
  }

  // Uses student5 (Fatima Ali), isolated from student4's webcam-alert
  // history built up by the tests above — those already lock a couple of
  // topics for student4 via the new grant-retake feature, which would
  // otherwise collide with reusing those same topic keys here.
  test('every submission from a forcedFail attempt is scored 0% and marked graded, even correct quiz answers', async () => {
    const res = await submitForced(student5Token, 'full-stack')();
    expect(res.status).toBe(200);
    expect(res.body.topicScore).toBe(0);
    expect(res.body.results.every((r) => r.type !== 'quiz' || r.correct !== undefined)).toBe(true); // grading still ran normally underneath

    const heatmap = await request(app).get('/api/instructor/heatmap').set('Authorization', 'Bearer ' + instructorToken);
    const student = heatmap.body.students.find((s) => s.name === 'Fatima Ali');
    expect(student.scores['full-stack']).toBe(0);

    // A Q&A item in this exam should be forced straight to graded/0, never
    // left sitting in the pending-review queue.
    const pending = await request(app).get('/api/instructor/pending-qa').set('Authorization', 'Bearer ' + instructorToken);
    expect(pending.body.some((p) => p.studentName === 'Fatima Ali' && p.topicName === 'Full Stack Development')).toBe(false);
  });

  test('the live exam:submitted broadcast marks it forcedFail so the dashboard can render it as a failure, not a normal score', (done) => {
    const instrSocket = connect(instructorToken);
    instrSocket.on('connect', async () => {
      instrSocket.on('exam:submitted', (payload) => {
        expect(payload.topicKey).toBe('networking');
        expect(payload.forcedFail).toBe(true);
        expect(payload.score).toBe(0);
        instrSocket.close();
        done();
      });
      await submitForced(student5Token, 'networking')();
    });
  }, 10000);

  test('a locked topic unlocks after the instructor grants a retake, and the voided score stops counting', async () => {
    // Mirrors the real client flow: the exam is fetched BEFORE any strike
    // happens, and the submit later reuses those same items.
    const examRes = await request(app).get('/api/student/exam/cybersecurity').set('Authorization', 'Bearer ' + student5Token);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'a normal response', confidence: 3 });

    const studSocket = connect(student5Token);
    const instrSocket = connect(instructorToken);
    await Promise.all([
      new Promise((r) => studSocket.on('connect', r)),
      new Promise((r) => instrSocket.on('connect', r)),
    ]);

    studSocket.emit('exam:start', { topicKey: 'cybersecurity', topicName: 'Cybersecurity', total: responses.length });
    const alertPromise = new Promise((resolve) => instrSocket.on('integrity:webcamAlert', resolve));
    studSocket.emit('exam:webcamAlert', { topicKey: 'cybersecurity', count: 3, snapshot: TINY_SNAPSHOT });
    const alertPayload = await alertPromise;

    const submitRes = await request(app).post('/api/student/exam/cybersecurity/submit').set('Authorization', 'Bearer ' + student5Token)
      .send({ responses, forcedFail: true });
    expect(submitRes.body.topicScore).toBe(0);

    const lockedRes = await request(app).get('/api/student/exam/cybersecurity').set('Authorization', 'Bearer ' + student5Token);
    expect(lockedRes.status).toBe(403);

    const resumedPromise = new Promise((resolve) => studSocket.on('exam:retakeGranted', resolve));
    const grantRes = await request(app).post(`/api/instructor/webcam-alerts/${alertPayload.alertId}/grant-retake`).set('Authorization', 'Bearer ' + instructorToken);
    expect(grantRes.body.ok).toBe(true);
    await resumedPromise;

    const unlockedRes = await request(app).get('/api/student/exam/cybersecurity').set('Authorization', 'Bearer ' + student5Token);
    expect(unlockedRes.status).toBe(200);

    const topics = await request(app).get('/api/student/topics').set('Authorization', 'Bearer ' + student5Token);
    const cyberTopic = topics.body.find((t) => t.key === 'cybersecurity');
    expect(cyberTopic.locked).toBe(false);
    expect(cyberTopic.myScore).toBe(null); // the failed attempt is voided; nothing else submitted since

    studSocket.close();
    instrSocket.close();
  }, 10000);

  test('a normal submit (no forcedFail) is unaffected and keeps real per-item scores', async () => {
    const examRes = await request(app).get('/api/student/exam/cloud-computing').set('Authorization', 'Bearer ' + studentToken);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'a normal response', confidence: 3 });
    const res = await request(app).post('/api/student/exam/cloud-computing/submit').set('Authorization', 'Bearer ' + studentToken).send({ responses });
    expect(res.status).toBe(200);
    expect(typeof res.body.topicScore).toBe('number');
    // Not forced to exactly 0 unless every real answer happened to be wrong/ungraded.
    expect(res.body.results.some((r) => r.type === 'qa' && r.status === 'pending_review')).toBe(true);
  });
});
