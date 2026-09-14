// Integration tests for the exam-integrity features: cross-student
// similarity flagging and the browser-reported event trail (tab-switch,
// fullscreen exit). Drives the real app with supertest, same as api.test.js.
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

require('../server/seed');
const request = require('supertest');
const { app } = require('../server/server');

let student1Token, student2Token, student3Token, instructorToken;

beforeAll(async () => {
  const s1 = await request(app).post('/api/auth/student/login').send({ username: 'student1', password: 'Pulse#Student1' });
  student1Token = s1.body.token;
  const s2 = await request(app).post('/api/auth/student/login').send({ username: 'student2', password: 'Pulse#Student2' });
  student2Token = s2.body.token;
  const s3 = await request(app).post('/api/auth/student/login').send({ username: 'student3', password: 'Pulse#Student3' });
  student3Token = s3.body.token;
  const i = await request(app).post('/api/auth/instructor/login').send({ username: 'prof.demo', password: 'MasterClass#2026' });
  instructorToken = i.body.token;
});

function submitWithQaText(token, text) {
  return async () => {
    const examRes = await request(app).get('/api/student/exam/cybersecurity').set('Authorization', 'Bearer ' + token);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : it.type === 'qa'
        ? { itemId: it.id, type: 'qa', text, confidence: 3 }
        : { itemId: it.id, type: it.type, text: 'a normal task response', confidence: 3 });
    return request(app).post('/api/student/exam/cybersecurity/submit').set('Authorization', 'Bearer ' + token).send({ responses });
  };
}

describe('cross-student answer similarity', () => {
  const nearlyIdentical = 'Phishing tricks a user into revealing their credentials via a fake but convincing email or website that impersonates a trusted sender.';
  const slightVariant = 'Phishing tricks a user into revealing their credentials through a fake, convincing email or website impersonating a trusted sender.';
  const genuinelyDifferent = 'A zero-day is a flaw the vendor does not yet know about, so there is no patch available when it is first exploited.';

  test('two near-identical Q&A answers to the same prompt get flagged', async () => {
    await submitWithQaText(student1Token, nearlyIdentical)();
    await submitWithQaText(student2Token, slightVariant)();

    const res = await request(app).get('/api/instructor/integrity').set('Authorization', 'Bearer ' + instructorToken);
    const match = res.body.similarity.find((f) =>
      [f.studentName, f.matchedStudentName].includes('Aiden Cross') &&
      [f.studentName, f.matchedStudentName].includes('Maria Okafor'));
    expect(match).toBeDefined();
    expect(match.similarity).toBeGreaterThanOrEqual(60);
  });

  test('a genuinely different answer to the same prompt is not flagged against the others', async () => {
    await submitWithQaText(student3Token, genuinelyDifferent)();

    const res = await request(app).get('/api/instructor/integrity').set('Authorization', 'Bearer ' + instructorToken);
    const wrongMatch = res.body.similarity.find((f) =>
      [f.studentName, f.matchedStudentName].includes('Ravi Shah'));
    expect(wrongMatch).toBeUndefined();
  });

  test('flagged students show up marked on the heatmap for that topic', async () => {
    const res = await request(app).get('/api/instructor/heatmap').set('Authorization', 'Bearer ' + instructorToken);
    const aiden = res.body.students.find((s) => s.name === 'Aiden Cross');
    expect(aiden.flagged.cybersecurity).toBe(true);
  });

  test('a student never sees similarity flags in their own submit response', async () => {
    const res = await submitWithQaText(student1Token, nearlyIdentical)();
    expect(JSON.stringify(res.body)).not.toMatch(/similarity/i);
  });
});

describe('browser-reported integrity events', () => {
  test('tab-switch and fullscreen-exit events are stored against the exam and surfaced to the instructor', async () => {
    const examRes = await request(app).get('/api/student/exam/networking').set('Authorization', 'Bearer ' + student1Token);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'response', confidence: 3 });
    const integrityEvents = [
      { type: 'tab-hidden', ts: Date.now() - 5000 },
      { type: 'fullscreen-exited', ts: Date.now() - 1000 },
    ];

    await request(app).post('/api/student/exam/networking/submit').set('Authorization', 'Bearer ' + student1Token).send({ responses, integrityEvents });

    const detail = await request(app).get('/api/instructor/detail/2/networking').set('Authorization', 'Bearer ' + instructorToken);
    expect(detail.body.integrityEvents.length).toBeGreaterThan(0);
    expect(detail.body.integrityEvents[0].events.map((e) => e.type)).toEqual(expect.arrayContaining(['tab-hidden', 'fullscreen-exited']));

    const list = await request(app).get('/api/instructor/integrity').set('Authorization', 'Bearer ' + instructorToken);
    expect(list.body.events.some((e) => e.studentName === 'Aiden Cross' && e.topicKey === 'networking')).toBe(true);
  });

  test('a submission with no integrity events stores nothing extra', async () => {
    const examRes = await request(app).get('/api/student/exam/cloud-computing').set('Authorization', 'Bearer ' + student2Token);
    const responses = examRes.body.items.map((it) => it.type === 'quiz'
      ? { itemId: it.id, type: 'quiz', selectedIndex: 0, confidence: 3 }
      : { itemId: it.id, type: it.type, text: 'response', confidence: 3 });
    const res = await request(app).post('/api/student/exam/cloud-computing/submit').set('Authorization', 'Bearer ' + student2Token).send({ responses });
    expect(res.status).toBe(200);

    const detail = await request(app).get('/api/instructor/detail/3/cloud-computing').set('Authorization', 'Bearer ' + instructorToken);
    expect(detail.body.integrityEvents.length).toBe(0);
  });
});
