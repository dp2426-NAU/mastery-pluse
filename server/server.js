const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createServer } = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { login, verifyToken, requireRole } = require('./auth');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = createServer(app);
const io = new Server(server);

const parseJSON = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// ---------- Auth ----------
app.post('/api/auth/student/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password, 'student');
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

app.post('/api/auth/instructor/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password, 'instructor');
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

// ---------- Grading ----------
function gradeAndStore(userId, topicId, responses) {
  const examRun = Date.now();
  const results = [];
  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO submissions (user_id, topic_id, item_id, type, selected_index, response_text, auto_score, misconception_tag, status, exam_run)
    VALUES (@user_id, @topic_id, @item_id, @type, @selected_index, @response_text, @auto_score, @misconception_tag, @status, @exam_run)
  `);

  for (const r of responses) {
    const item = getItem.get(r.itemId);
    if (!item || item.topic_id !== topicId) continue;

    let row = {
      user_id: userId, topic_id: topicId, item_id: item.id, type: item.type,
      selected_index: null, response_text: null, auto_score: null,
      misconception_tag: null, status: 'graded', exam_run: examRun,
    };

    if (item.type === 'quiz') {
      const options = parseJSON(item.options, []);
      const misconceptions = parseJSON(item.misconceptions, []);
      const selected = Number(r.selectedIndex);
      const correct = selected === item.correct_index;
      row.selected_index = selected;
      row.auto_score = correct ? 100 : 0;
      row.misconception_tag = correct ? null : (misconceptions[selected] || null);
      results.push({ itemId: item.id, type: 'quiz', correct, correctIndex: item.correct_index, options, question: item.prompt });
    } else if (item.type === 'task') {
      const keywords = parseJSON(item.keywords, []);
      const text = (r.text || '').toLowerCase();
      const matched = keywords.filter(k => text.includes(k.toLowerCase()));
      const score = keywords.length ? Math.round((matched.length / keywords.length) * 100) : 0;
      row.response_text = r.text || '';
      row.auto_score = score;
      results.push({ itemId: item.id, type: 'task', score, matched, missing: keywords.filter(k => !matched.includes(k)) });
    } else { // qa
      row.response_text = r.text || '';
      row.status = 'pending_review';
      results.push({ itemId: item.id, type: 'qa', status: 'pending_review' });
    }

    insert.run(row);
  }
  return results;
}

function topicScoreFor(userId, topicId) {
  const row = db.prepare(`
    SELECT AVG(auto_score) AS avg FROM submissions
    WHERE user_id = ? AND topic_id = ? AND status = 'graded'
  `).get(userId, topicId);
  return row.avg == null ? null : Math.round(row.avg);
}

function classAverageFor(topicId) {
  const row = db.prepare(`
    SELECT AVG(auto_score) AS avg FROM submissions WHERE topic_id = ? AND status = 'graded'
  `).get(topicId);
  return row.avg == null ? null : Math.round(row.avg);
}

// ---------- Student API ----------
app.get('/api/student/topics', requireRole('student'), (req, res) => {
  const topics = db.prepare('SELECT * FROM topics ORDER BY name').all();
  res.json(topics.map(t => ({
    key: t.key, name: t.name, myScore: topicScoreFor(req.user.sub, t.id),
  })));
});

app.get('/api/student/exam/:topicKey', requireRole('student'), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.params.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });
  const items = db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY type').all(topic.id);
  res.json({
    topic: topic.key,
    topicName: topic.name,
    items: items.map(it => ({
      id: it.id, type: it.type, prompt: it.prompt,
      options: it.type === 'quiz' ? parseJSON(it.options, []) : undefined,
    })),
  });
});

app.post('/api/student/exam/:topicKey/submit', requireRole('student'), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.params.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });
  const responses = (req.body && req.body.responses) || [];

  const results = gradeAndStore(req.user.sub, topic.id, responses);
  const topicScore = topicScoreFor(req.user.sub, topic.id);
  const classAverage = classAverageFor(topic.id);
  const pendingQA = results.filter(r => r.type === 'qa').length;

  activeExams.delete(req.user.sub);
  io.to('instructors').emit('presence:clear', { studentId: req.user.sub });

  io.to('instructors').emit('exam:submitted', {
    studentId: req.user.sub, studentName: req.user.name,
    topicKey: topic.key, topicName: topic.name,
    score: topicScore, pendingQA, ts: Date.now(),
  });

  res.json({ topicScore, classAverage, results });
});

app.get('/api/student/remediation', requireRole('student'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.message, r.created_at, t.key AS topicKey, t.name AS topicName
    FROM remediations r JOIN topics t ON t.id = r.topic_id
    ORDER BY r.created_at DESC LIMIT 5
  `).all();
  res.json(rows);
});

app.get('/api/student/remediation/:id', requireRole('student'), (req, res) => {
  const rem = db.prepare('SELECT * FROM remediations WHERE id = ?').get(req.params.id);
  if (!rem) return res.status(404).json({ error: 'Not found.' });
  const ids = parseJSON(rem.item_ids, []);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(rem.topic_id);
  const items = ids.map(id => db.prepare('SELECT * FROM items WHERE id = ?').get(id)).filter(Boolean);
  res.json({
    topic: topic.key, topicName: topic.name, message: rem.message,
    items: items.map(it => ({ id: it.id, type: it.type, prompt: it.prompt, options: it.type === 'quiz' ? parseJSON(it.options, []) : undefined })),
  });
});

// ---------- Instructor API ----------
app.get('/api/instructor/heatmap', requireRole('instructor'), (req, res) => {
  const topics = db.prepare('SELECT * FROM topics ORDER BY name').all();
  const students = db.prepare("SELECT * FROM users WHERE role = 'student' ORDER BY display_name").all();

  const cells = {};
  students.forEach(s => { cells[s.id] = {}; });
  const scored = db.prepare(`
    SELECT user_id, topic_id, AVG(auto_score) AS avg
    FROM submissions WHERE status = 'graded' GROUP BY user_id, topic_id
  `).all();
  scored.forEach(row => {
    if (!cells[row.user_id]) cells[row.user_id] = {};
    cells[row.user_id][row.topic_id] = Math.round(row.avg);
  });

  const misconceptionRows = db.prepare(`
    SELECT topic_id, misconception_tag, COUNT(*) AS n
    FROM submissions WHERE misconception_tag IS NOT NULL
    GROUP BY topic_id, misconception_tag
  `).all();
  const topMisconception = {};
  misconceptionRows.forEach(r => {
    if (!topMisconception[r.topic_id] || topMisconception[r.topic_id].n < r.n) {
      topMisconception[r.topic_id] = { tag: r.misconception_tag, n: r.n };
    }
  });

  const pendingCounts = db.prepare(`
    SELECT topic_id, COUNT(*) AS n FROM submissions WHERE status = 'pending_review' GROUP BY topic_id
  `).all();
  const pendingByTopic = {};
  pendingCounts.forEach(r => pendingByTopic[r.topic_id] = r.n);

  res.json({
    topics: topics.map(t => ({
      key: t.key, name: t.name,
      topMisconception: topMisconception[t.id] || null,
      pendingQA: pendingByTopic[t.id] || 0,
    })),
    students: students.map(s => ({
      id: s.id, name: s.display_name,
      scores: Object.fromEntries(topics.map(t => [t.key, cells[s.id][t.id] ?? null])),
    })),
  });
});

app.get('/api/instructor/presence', requireRole('instructor'), (req, res) => {
  res.json({
    online: onlineStudents.size,
    active: [...activeExams.values()],
  });
});

app.get('/api/instructor/detail/:studentId/:topicKey', requireRole('instructor'), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.params.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });
  const subs = db.prepare(`
    SELECT s.*, i.prompt, i.options, i.correct_index, i.keywords
    FROM submissions s JOIN items i ON i.id = s.item_id
    WHERE s.user_id = ? AND s.topic_id = ? ORDER BY s.ts DESC
  `).all(req.params.studentId, topic.id);

  res.json(subs.map(s => ({
    id: s.id, type: s.type, status: s.status, autoScore: s.auto_score,
    misconceptionTag: s.misconception_tag, ts: s.ts,
    prompt: s.prompt,
    options: s.options ? parseJSON(s.options, []) : undefined,
    selectedIndex: s.selected_index,
    correctIndex: s.correct_index,
    responseText: s.response_text,
    keywords: s.keywords ? parseJSON(s.keywords, []) : undefined,
  })));
});

app.get('/api/instructor/pending-qa', requireRole('instructor'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, u.display_name AS studentName, t.name AS topicName, i.prompt, s.response_text, s.ts
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    JOIN topics t ON t.id = s.topic_id
    JOIN items i ON i.id = s.item_id
    WHERE s.status = 'pending_review'
    ORDER BY s.ts ASC
  `).all();
  res.json(rows);
});

app.post('/api/instructor/review', requireRole('instructor'), (req, res) => {
  const { submissionId, score } = req.body || {};
  const clamped = Math.max(0, Math.min(100, Number(score)));
  db.prepare("UPDATE submissions SET auto_score = ?, status = 'graded' WHERE id = ?").run(clamped, submissionId);
  const sub = db.prepare(`
    SELECT s.*, u.display_name AS studentName, t.name AS topicName, t.key AS topicKey
    FROM submissions s JOIN users u ON u.id = s.user_id JOIN topics t ON t.id = s.topic_id
    WHERE s.id = ?
  `).get(submissionId);
  io.to('instructors').emit('qa:reviewed', {
    submissionId, userId: sub.user_id, topicId: sub.topic_id, topicKey: sub.topicKey,
    studentName: sub.studentName, topicName: sub.topicName, score: clamped,
  });
  res.json({ ok: true });
});

app.post('/api/instructor/remediate', requireRole('instructor'), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get((req.body || {}).topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });

  let missed = db.prepare(`
    SELECT item_id, COUNT(*) AS misses FROM submissions
    WHERE topic_id = ? AND type = 'quiz' AND auto_score = 0
    GROUP BY item_id ORDER BY misses DESC LIMIT 5
  `).all(topic.id).map(r => r.item_id);

  if (missed.length === 0) {
    missed = db.prepare("SELECT id FROM items WHERE topic_id = ? AND type = 'quiz' LIMIT 3").all(topic.id).map(r => r.id);
  }

  const message = `Extra practice recommended in ${topic.name} based on class results.`;
  const info = db.prepare('INSERT INTO remediations (topic_id, item_ids, message) VALUES (?, ?, ?)')
    .run(topic.id, JSON.stringify(missed), message);

  io.to('students').emit('remediation:new', { topicKey: topic.key, topicName: topic.name, message });

  res.json({ id: info.lastInsertRowid, itemIds: missed, message });
});

// ---------- Socket.IO ----------
// userId -> Set of live socket ids (a student can have >1 tab open)
const onlineStudents = new Map();
// userId -> { studentId, studentName, topicKey, topicName, answered, total } while an exam is in progress
const activeExams = new Map();

function broadcastOnline() {
  io.to('instructors').emit('presence:online', { count: onlineStudents.size });
}

io.use((socket, next) => {
  const claims = socket.handshake.auth?.token && verifyToken(socket.handshake.auth.token);
  if (!claims) return next(new Error('Unauthorized socket connection.'));
  socket.user = claims;
  next();
});

io.on('connection', (socket) => {
  const { role, sub: userId, name } = socket.user;
  socket.join(role === 'instructor' ? 'instructors' : 'students');

  if (role === 'instructor') {
    // Let a freshly-opened dashboard know who's online right away.
    socket.emit('presence:online', { count: onlineStudents.size });
    return;
  }

  // ---- student presence: who's connected, and what they're mid-way through ----
  if (!onlineStudents.has(userId)) onlineStudents.set(userId, new Set());
  onlineStudents.get(userId).add(socket.id);
  broadcastOnline();

  socket.on('exam:start', ({ topicKey, topicName, total }) => {
    const state = { studentId: userId, studentName: name, topicKey, topicName, answered: 0, total: total || 0 };
    activeExams.set(userId, state);
    io.to('instructors').emit('presence:progress', state);
  });

  socket.on('exam:progress', ({ answered }) => {
    const state = activeExams.get(userId);
    if (!state) return;
    state.answered = answered;
    io.to('instructors').emit('presence:progress', state);
  });

  socket.on('disconnect', () => {
    const set = onlineStudents.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      onlineStudents.delete(userId);
      activeExams.delete(userId);
      io.to('instructors').emit('presence:clear', { studentId: userId });
    }
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mastery Pulse server listening on ${PORT}`));
