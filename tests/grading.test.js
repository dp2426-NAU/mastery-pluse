// Unit tests for the grading engine, run against a real in-memory copy of
// the actual seeded content (server/topics/*.json) — not fixtures, so a
// changed answer key or a broken misconception mapping fails a real test.
process.env.DB_PATH = ':memory:';

require('../server/seed'); // seeds real topics/items/users into the in-memory db
const db = require('../server/db');
const { gradeAndStore, topicScoreFor, classAverageFor, timeLimitFor } = require('../server/grading');

function getTopic(key) { return db.prepare('SELECT * FROM topics WHERE key = ?').get(key); }
function getItems(topicId) { return db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY type, id').all(topicId); }
// submissions.user_id has a real foreign key to users(id) — a made-up id
// like 9001 fails that constraint, so tests get their own throwaway
// student accounts instead of hardcoding ids that don't exist yet.
let nextTestUser = 0;
function makeTestStudent() {
  nextTestUser += 1;
  const username = `test-student-${nextTestUser}`;
  const info = db.prepare("INSERT INTO users (username, password_hash, role, display_name) VALUES (?, 'x', 'student', ?)").run(username, username);
  return info.lastInsertRowid;
}

const topic = getTopic('cybersecurity');
const items = getItems(topic.id);
const leastPrivilegeItem = items.find((i) => i.type === 'quiz' && i.prompt.includes('least privilege'));
const hardenItem = items.find((i) => i.type === 'task' && i.prompt.includes('harden'));
const qaItem = items.find((i) => i.type === 'qa');

describe('gradeAndStore — quiz', () => {
  test('a correct answer scores 100 and tags no misconception', () => {
    const student = makeTestStudent();
    const [result] = gradeAndStore(student, topic.id, [
      { itemId: leastPrivilegeItem.id, type: 'quiz', selectedIndex: leastPrivilegeItem.correct_index, confidence: 4 },
    ]);
    expect(result.correct).toBe(true);
    const row = db.prepare('SELECT * FROM submissions WHERE item_id = ? AND user_id = ?').get(leastPrivilegeItem.id, student);
    expect(row.auto_score).toBe(100);
    expect(row.misconception_tag).toBeNull();
  });

  test('a wrong answer tags the misconception mapped to that specific option', () => {
    const student = makeTestStudent();
    const misconceptions = JSON.parse(leastPrivilegeItem.misconceptions);
    const wrongIndex = misconceptions.findIndex((m, i) => i !== leastPrivilegeItem.correct_index && m);
    gradeAndStore(student, topic.id, [
      { itemId: leastPrivilegeItem.id, type: 'quiz', selectedIndex: wrongIndex, confidence: 5 },
    ]);
    const row = db.prepare('SELECT * FROM submissions WHERE item_id = ? AND user_id = ?').get(leastPrivilegeItem.id, student);
    expect(row.auto_score).toBe(0);
    expect(row.misconception_tag).toBe(misconceptions[wrongIndex]);
  });

  test('confidence is clamped into 1-5 even if the client sends garbage', () => {
    const student = makeTestStudent();
    gradeAndStore(student, topic.id, [
      { itemId: leastPrivilegeItem.id, type: 'quiz', selectedIndex: leastPrivilegeItem.correct_index, confidence: 99 },
    ]);
    const row = db.prepare('SELECT * FROM submissions WHERE item_id = ? AND user_id = ?').get(leastPrivilegeItem.id, student);
    expect(row.confidence).toBe(5);
  });

  test('an item belonging to a different topic is silently skipped, not mis-scored', () => {
    const student = makeTestStudent();
    const otherTopic = getTopic('networking');
    const results = gradeAndStore(student, otherTopic.id, [
      { itemId: leastPrivilegeItem.id, type: 'quiz', selectedIndex: leastPrivilegeItem.correct_index, confidence: 3 },
    ]);
    expect(results.length).toBe(0);
  });
});

describe('gradeAndStore — task (keyword coverage)', () => {
  test('score is the percentage of expected keywords present, case-insensitive', () => {
    const student = makeTestStudent();
    const keywords = JSON.parse(hardenItem.keywords);
    const half = keywords.slice(0, Math.ceil(keywords.length / 2)).join(' ').toUpperCase();
    const [result] = gradeAndStore(student, topic.id, [{ itemId: hardenItem.id, type: 'task', text: half, confidence: 3 }]);
    const expectedPct = Math.round((Math.ceil(keywords.length / 2) / keywords.length) * 100);
    expect(result.score).toBe(expectedPct);
  });

  test('a response with none of the expected keywords scores 0, not an error', () => {
    const student = makeTestStudent();
    const [result] = gradeAndStore(student, topic.id, [{ itemId: hardenItem.id, type: 'task', text: 'I have no idea.', confidence: 1 }]);
    expect(result.score).toBe(0);
  });

  test('every expected keyword present scores 100', () => {
    const student = makeTestStudent();
    const keywords = JSON.parse(hardenItem.keywords);
    const [result] = gradeAndStore(student, topic.id, [{ itemId: hardenItem.id, type: 'task', text: keywords.join(' — '), confidence: 4 }]);
    expect(result.score).toBe(100);
  });
});

describe('gradeAndStore — qa (never auto-graded, by design)', () => {
  const student = makeTestStudent();

  test('is saved as pending_review with no auto_score', () => {
    gradeAndStore(student, topic.id, [{ itemId: qaItem.id, type: 'qa', text: 'My answer, in my own words.', confidence: 3 }]);
    const row = db.prepare('SELECT * FROM submissions WHERE item_id = ? AND user_id = ?').get(qaItem.id, student);
    expect(row.status).toBe('pending_review');
    expect(row.auto_score).toBeNull();
  });

  test('a pending Q&A does not count toward the topic average until an instructor grades it', () => {
    expect(topicScoreFor(student, topic.id)).toBeNull();
  });
});

describe('timeLimitFor', () => {
  test('floors at 4 minutes for very short exams', () => {
    expect(timeLimitFor(1)).toBe(240);
  });
  test('scales at 90 seconds/item once above the floor', () => {
    expect(timeLimitFor(10)).toBe(900);
  });
});

describe('classAverageFor', () => {
  test('is a plain number once at least one graded submission exists', () => {
    const student = makeTestStudent();
    gradeAndStore(student, topic.id, [
      { itemId: leastPrivilegeItem.id, type: 'quiz', selectedIndex: leastPrivilegeItem.correct_index, confidence: 3 },
    ]);
    expect(typeof classAverageFor(topic.id)).toBe('number');
  });

  test('is null for a topic nobody has attempted', () => {
    const untouchedTopic = db.prepare('INSERT INTO topics (key, name) VALUES (?, ?)').run('untouched-topic', 'Untouched Topic');
    expect(classAverageFor(untouchedTopic.lastInsertRowid)).toBeNull();
  });
});
