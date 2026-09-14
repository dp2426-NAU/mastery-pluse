// Integration tests: drives the real Express app (no mocks) with supertest,
// against an isolated in-memory database seeded with the real content.
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

require('../server/seed');
const request = require('supertest');
const { app } = require('../server/server');

let studentToken;
let instructorToken;

beforeAll(async () => {
  const s = await request(app).post('/api/auth/student/login').send({ username: 'student1', password: 'Pulse#Student1' });
  studentToken = s.body.token;
  const i = await request(app).post('/api/auth/instructor/login').send({ username: 'prof.demo', password: 'MasterClass#2026' });
  instructorToken = i.body.token;
});

test('sanity: both demo accounts actually logged in', () => {
  expect(studentToken).toBeDefined();
  expect(instructorToken).toBeDefined();
});

describe('role separation is enforced on every request, not just hidden in the UI', () => {
  test('an instructor token cannot call a /api/student/* route', async () => {
    const res = await request(app).get('/api/student/topics').set('Authorization', 'Bearer ' + instructorToken);
    expect(res.status).toBe(403);
  });

  test('a student token cannot call a /api/instructor/* route', async () => {
    const res = await request(app).get('/api/instructor/heatmap').set('Authorization', 'Bearer ' + studentToken);
    expect(res.status).toBe(403);
  });

  test('no token at all is rejected the same way', async () => {
    const res = await request(app).get('/api/student/topics');
    expect(res.status).toBe(403);
  });

  test('a student cannot even mint an instructor token with correct-looking credentials', async () => {
    const res = await request(app).post('/api/auth/instructor/login').send({ username: 'student1', password: 'Pulse#Student1' });
    expect(res.status).toBe(401);
  });
});

describe('input validation rejects malformed requests with a clear 400', () => {
  test('login with a missing password', async () => {
    const res = await request(app).post('/api/auth/student/login').send({ username: 'student1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('submitting zero responses', async () => {
    const res = await request(app)
      .post('/api/student/exam/networking/submit')
      .set('Authorization', 'Bearer ' + studentToken)
      .send({ responses: [] });
    expect(res.status).toBe(400);
  });

  test('submitting a response with a non-numeric itemId', async () => {
    const res = await request(app)
      .post('/api/student/exam/networking/submit')
      .set('Authorization', 'Bearer ' + studentToken)
      .send({ responses: [{ itemId: 'not-a-number', type: 'quiz', selectedIndex: 0 }] });
    expect(res.status).toBe(400);
  });

  test('grading a Q&A with an out-of-range score', async () => {
    const res = await request(app)
      .post('/api/instructor/review')
      .set('Authorization', 'Bearer ' + instructorToken)
      .send({ submissionId: 1, score: 250 });
    expect(res.status).toBe(400);
  });
});

describe('the full mixed-type submit flow', () => {
  test('a student can fetch a topic exam and see a time limit and options, but never the answer key', async () => {
    const res = await request(app).get('/api/student/exam/networking').set('Authorization', 'Bearer ' + studentToken);
    expect(res.status).toBe(200);
    expect(res.body.timeLimitSeconds).toBeGreaterThan(0);
    const quizItem = res.body.items.find((i) => i.type === 'quiz');
    expect(quizItem.correctIndex).toBeUndefined();
    expect(quizItem.misconceptions).toBeUndefined();
  });

  test('submitting a mixed quiz/task/qa exam returns a topic score in the same response', async () => {
    const examRes = await request(app).get('/api/student/exam/networking').set('Authorization', 'Bearer ' + studentToken);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'a realistic response covering the prompt', confidence: 3 });

    const submitRes = await request(app)
      .post('/api/student/exam/networking/submit')
      .set('Authorization', 'Bearer ' + studentToken)
      .send({ responses });

    expect(submitRes.status).toBe(200);
    expect(typeof submitRes.body.topicScore).toBe('number');
    expect(submitRes.body.results.length).toBe(responses.length);
    // the Q&A item(s) must not block the quiz/task score from being present
    expect(submitRes.body.results.some((r) => r.type === 'qa')).toBe(true);
  });
});

describe('the instructor drill-down and heatmap reflect what actually happened', () => {
  test('heatmap includes the student who just submitted', async () => {
    const res = await request(app).get('/api/instructor/heatmap').set('Authorization', 'Bearer ' + instructorToken);
    const me = res.body.students.find((s) => s.name === 'Aiden Cross');
    expect(me).toBeDefined();
    expect(me.scores.networking).not.toBeNull();
  });

  test('the pending Q&A queue is non-empty after that submission', async () => {
    const res = await request(app).get('/api/instructor/pending-qa').set('Authorization', 'Bearer ' + instructorToken);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('grading a Q&A moves it out of the pending queue', async () => {
    const before = await request(app).get('/api/instructor/pending-qa').set('Authorization', 'Bearer ' + instructorToken);
    const target = before.body[0];
    await request(app)
      .post('/api/instructor/review')
      .set('Authorization', 'Bearer ' + instructorToken)
      .send({ submissionId: target.id, score: 80 });
    const after = await request(app).get('/api/instructor/pending-qa').set('Authorization', 'Bearer ' + instructorToken);
    expect(after.body.find((r) => r.id === target.id)).toBeUndefined();
  });
});

describe('remediation records a real before-average the instant it is sent', () => {
  test('clicking remediate on a topic with submissions captures a non-null beforeAvg', async () => {
    const res = await request(app)
      .post('/api/instructor/remediate')
      .set('Authorization', 'Bearer ' + instructorToken)
      .send({ topicKey: 'networking' });
    expect(res.status).toBe(200);

    const impact = await request(app).get('/api/instructor/remediation-impact').set('Authorization', 'Bearer ' + instructorToken);
    const row = impact.body.find((r) => r.topicKey === 'networking');
    expect(row).toBeDefined();
    expect(row.beforeAvg).not.toBeNull();
  });

  test('an unknown topic key is rejected with 404, not a crash', async () => {
    const res = await request(app)
      .post('/api/instructor/remediate')
      .set('Authorization', 'Bearer ' + instructorToken)
      .send({ topicKey: 'made-up-topic' });
    expect(res.status).toBe(404);
  });
});

describe('/health', () => {
  test('responds without auth, for uptime checks', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
