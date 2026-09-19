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

beforeAll((done) => {
  server.listen(0, async () => {
    port = server.address().port;
    const s = await request(app).post('/api/auth/student/login').send({ username: 'student4', password: 'Pulse#Student4' });
    studentToken = s.body.token;
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

describe('exam pause / instructor approval', () => {
  test('a 3rd-strike alert pauses the exam on the student\'s own socket', (done) => {
    const instrSocket = connect(instructorToken);
    const studSocket = connect(studentToken);

    Promise.all([
      new Promise((r) => instrSocket.on('connect', r)),
      new Promise((r) => studSocket.on('connect', r)),
    ]).then(() => {
      studSocket.on('exam:paused', (payload) => {
        expect(payload.topicKey).toBe('full-stack');
        expect(typeof payload.reason).toBe('string');
        expect(payload.reason.length).toBeGreaterThan(0);
        instrSocket.close();
        studSocket.close();
        done();
      });
      studSocket.emit('exam:start', { topicKey: 'full-stack', topicName: 'Full Stack Development', total: 5 });
      studSocket.emit('exam:webcamAlert', { topicKey: 'full-stack', count: 3, snapshot: TINY_SNAPSHOT });
    });
  }, 10000);

  test('an instructor approving the alert resumes that exact student live and marks it resolved', (done) => {
    const instrSocket = connect(instructorToken);
    const studSocket = connect(studentToken);
    let alertId;

    Promise.all([
      new Promise((r) => instrSocket.on('connect', r)),
      new Promise((r) => studSocket.on('connect', r)),
    ]).then(() => {
      instrSocket.on('integrity:webcamAlert', async (payload) => {
        alertId = payload.alertId;
        expect(alertId).toBeDefined();
        const res = await request(app).post(`/api/instructor/webcam-alerts/${alertId}/approve`).set('Authorization', 'Bearer ' + instructorToken);
        expect(res.body.resumed).toBe(true);
      });
      studSocket.on('exam:resumed', async (payload) => {
        expect(payload.topicKey).toBe('cybersecurity');
        const rows = await request(app).get('/api/instructor/webcam-alerts').set('Authorization', 'Bearer ' + instructorToken);
        const row = rows.body.find((r) => r.id === alertId);
        expect(row.resolved).toBe(true);
        instrSocket.close();
        studSocket.close();
        done();
      });
      studSocket.emit('exam:start', { topicKey: 'cybersecurity', topicName: 'Cybersecurity', total: 5 });
      studSocket.emit('exam:webcamAlert', { topicKey: 'cybersecurity', count: 3, snapshot: TINY_SNAPSHOT });
    });
  }, 10000);

  test('approving an alert after the student has disconnected resolves it without claiming to resume anything', (done) => {
    const instrSocket = connect(instructorToken);
    const studSocket = connect(studentToken);

    Promise.all([
      new Promise((r) => instrSocket.on('connect', r)),
      new Promise((r) => studSocket.on('connect', r)),
    ]).then(() => {
      instrSocket.on('integrity:webcamAlert', async (payload) => {
        studSocket.close();
        setTimeout(async () => {
          const res = await request(app).post(`/api/instructor/webcam-alerts/${payload.alertId}/approve`).set('Authorization', 'Bearer ' + instructorToken);
          expect(res.body.ok).toBe(true);
          expect(res.body.resumed).toBe(false);
          instrSocket.close();
          done();
        }, 200);
      });
      studSocket.emit('exam:start', { topicKey: 'web-technology', topicName: 'Web Technology', total: 5 });
      studSocket.emit('exam:webcamAlert', { topicKey: 'web-technology', count: 3, snapshot: TINY_SNAPSHOT });
    });
  }, 10000);
});
