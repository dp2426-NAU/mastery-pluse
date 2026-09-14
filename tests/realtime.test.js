// Exercises the actual real-time channel end to end: a real HTTP server on
// an ephemeral port, real socket.io-client connections, real REST calls
// driving the events — this is the part that makes the app a "client-server
// architecture" project rather than a CRUD form, so it gets its own suite.
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
    const s = await request(app).post('/api/auth/student/login').send({ username: 'student2', password: 'Pulse#Student2' });
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

test('a socket with an invalid token is rejected at the handshake, before joining any room', (done) => {
  const bad = connect('this-is-not-a-real-jwt');
  bad.on('connect_error', () => { bad.close(); done(); });
  bad.on('connect', () => { bad.close(); done(new Error('a forged token should never be allowed to connect')); });
});

test('exam:submitted reaches an already-open instructor socket the instant a student submits', (done) => {
  const instrSocket = connect(instructorToken);
  instrSocket.on('connect', async () => {
    instrSocket.on('exam:submitted', (payload) => {
      expect(payload.topicKey).toBe('cybersecurity');
      expect(typeof payload.score).toBe('number');
      instrSocket.close();
      done();
    });

    const examRes = await request(app).get('/api/student/exam/cybersecurity').set('Authorization', 'Bearer ' + studentToken);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'response', confidence: 3 });
    await request(app).post('/api/student/exam/cybersecurity/submit').set('Authorization', 'Bearer ' + studentToken).send({ responses });
  });
}, 10000);

test('a quiz pick is graded live and relayed as presence:progress before the exam is submitted', (done) => {
  const instrSocket = connect(instructorToken);
  const studSocket = connect(studentToken);

  Promise.all([
    new Promise((r) => instrSocket.on('connect', r)),
    new Promise((r) => studSocket.on('connect', r)),
  ]).then(async () => {
    const examRes = await request(app).get('/api/student/exam/networking').set('Authorization', 'Bearer ' + studentToken);
    const quizItem = examRes.body.items.find((i) => i.type === 'quiz');

    instrSocket.on('presence:progress', (p) => {
      if (p.quizTrail && p.quizTrail.length) {
        expect(typeof p.quizTrail[0].correct).toBe('boolean');
        expect(p.quizTrail[0].itemId).toBe(quizItem.id);
        instrSocket.close();
        studSocket.close();
        done();
      }
    });

    studSocket.emit('exam:start', { topicKey: 'networking', topicName: 'Networking', total: examRes.body.items.length });
    studSocket.emit('exam:answer', { itemId: quizItem.id, selectedIndex: 0 });
  });
}, 10000);

test('presence:clear fires for an instructor when a student disconnects mid-exam', (done) => {
  const instrSocket = connect(instructorToken);
  const studSocket = connect(studentToken);

  instrSocket.on('connect', () => {
    studSocket.on('connect', () => {
      studSocket.emit('exam:start', { topicKey: 'cloud-computing', topicName: 'Cloud Computing', total: 5 });
      instrSocket.on('presence:progress', () => {
        // now that the instructor has seen them start, disconnect abruptly
        studSocket.disconnect();
      });
      instrSocket.on('presence:clear', () => {
        instrSocket.close();
        done();
      });
    });
  });
}, 10000);

test('remediation:new reaches an open student socket the instant an instructor remediates', (done) => {
  const studSocket = connect(studentToken);
  studSocket.on('connect', async () => {
    studSocket.on('remediation:new', (payload) => {
      expect(payload.topicKey).toBe('web-technology');
      studSocket.close();
      done();
    });
    await request(app).post('/api/instructor/remediate').set('Authorization', 'Bearer ' + instructorToken).send({ topicKey: 'web-technology' });
  });
}, 10000);
