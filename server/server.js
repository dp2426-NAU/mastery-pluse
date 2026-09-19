// Loads a local .env file into process.env, if one exists (silently does
// nothing otherwise — Render sets real environment variables directly, and
// the test suite sets what it needs before ever requiring this file, so
// this only matters for local dev). Must run before anything below reads
// process.env.* at module-load time (auth.js's JWT_SECRET, in particular).
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createServer } = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { login, verifyToken, requireRole } = require('./auth');
const { parseJSON, timeLimitFor, topicScoreFor, classAverageFor, gradeAndStore } = require('./grading');
const { validate, loginSchema, submitSchema, reviewSchema, remediateSchema } = require('./validation');
const { loginLimiter, submitLimiter } = require('./rate-limit');
const { sendWebcamAlertEmail } = require('./mailer');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = createServer(app);
const io = new Server(server);

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// A topic is locked for a student the moment a webcam strike fails their
// exam, and stays locked until an instructor explicitly grants a retake
// (POST /api/instructor/webcam-alerts/:id/grant-retake) — see "student
// genuinely had a technical issue, talked to the professor" in the
// project history. This is a real gate, not just a courtesy: the exam
// route itself refuses to hand out items for a locked topic.
const isTopicLockedStmt = db.prepare(`
  SELECT 1 FROM webcam_alerts WHERE user_id = ? AND topic_id = ? AND resolved = 0 LIMIT 1
`);
function isTopicLocked(userId, topicId) {
  return !!isTopicLockedStmt.get(userId, topicId);
}

// ---------- Auth ----------
app.post('/api/auth/student/login', loginLimiter, validate(loginSchema), (req, res) => {
  const { username, password } = req.body;
  const result = login(username, password, 'student');
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

app.post('/api/auth/instructor/login', loginLimiter, validate(loginSchema), (req, res) => {
  const { username, password } = req.body;
  const result = login(username, password, 'instructor');
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

// ---------- Student API ----------
app.get('/api/student/topics', requireRole('student'), (req, res) => {
  const topics = db.prepare('SELECT * FROM topics ORDER BY name').all();
  res.json(topics.map(t => ({
    key: t.key, name: t.name, myScore: topicScoreFor(req.user.sub, t.id),
    locked: isTopicLocked(req.user.sub, t.id),
  })));
});

app.get('/api/student/exam/:topicKey', requireRole('student'), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.params.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });
  if (isTopicLocked(req.user.sub, topic.id)) {
    return res.status(403).json({ error: 'This topic is locked after a webcam integrity failure. Ask your instructor to grant a retake.' });
  }
  const items = db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY type').all(topic.id);
  res.json({
    topic: topic.key,
    topicName: topic.name,
    timeLimitSeconds: timeLimitFor(items.length),
    items: items.map(it => ({
      id: it.id, type: it.type, prompt: it.prompt,
      options: it.type === 'quiz' ? parseJSON(it.options, []) : undefined,
    })),
  });
});

app.post('/api/student/exam/:topicKey/submit', submitLimiter, requireRole('student'), validate(submitSchema), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.params.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });
  const { responses, integrityEvents, forcedFail } = req.body;

  // Reuse the exam_run already established at exam:start (if this attempt
  // had one) rather than letting gradeAndStore mint a fresh one — a
  // webcam_alerts row for a hard-fail is written against THAT exam_run,
  // and granting a retake later needs to void the exact same rows by
  // matching on it.
  const liveState = activeExams.get(req.user.sub);
  const results = gradeAndStore(req.user.sub, topic.id, responses, liveState?.examRun);

  // A 3rd webcam strike ends the exam immediately as a hard fail — not a
  // pause, not a review queue. Every submission from THIS exam attempt is
  // forced to 0% and marked graded (never left "pending review", so it
  // doesn't linger in the Q&A queue). What was actually answered, and
  // whether it was individually correct, is still preserved underneath —
  // visible in the instructor's drill-down — this only forces the score.
  if (forcedFail) {
    db.prepare("UPDATE submissions SET auto_score = 0, status = 'graded' WHERE user_id = ? AND topic_id = ? AND exam_run = ?")
      .run(req.user.sub, topic.id, results.examRun);
  }

  const topicScore = topicScoreFor(req.user.sub, topic.id);
  const classAverage = classAverageFor(topic.id);
  const pendingQA = forcedFail ? 0 : results.filter(r => r.type === 'qa').length;

  if (integrityEvents && integrityEvents.length) {
    db.prepare('INSERT INTO exam_integrity (user_id, topic_id, exam_run, events) VALUES (?, ?, ?, ?)')
      .run(req.user.sub, topic.id, results.examRun, JSON.stringify(integrityEvents));
  }

  activeExams.delete(req.user.sub);
  clearWebcamEmailFlags(req.user.sub);
  io.to('instructors').emit('presence:clear', { studentId: req.user.sub });

  io.to('instructors').emit('exam:submitted', {
    studentId: req.user.sub, studentName: req.user.name,
    topicKey: topic.key, topicName: topic.name,
    score: topicScore, pendingQA, ts: Date.now(),
    integrityFlags: integrityEvents ? integrityEvents.length : 0,
    forcedFail: !!forcedFail,
  });

  results.similarityFlags.forEach((flag) => {
    io.to('instructors').emit('integrity:similarity', {
      studentName: req.user.name, matchedStudentName: flag.matchedStudentName,
      topicName: topic.name, similarity: flag.similarity, ts: Date.now(),
    });
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
    timeLimitSeconds: timeLimitFor(items.length),
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
    FROM submissions WHERE status = 'graded' AND voided = 0 GROUP BY user_id, topic_id
  `).all();
  scored.forEach(row => {
    if (!cells[row.user_id]) cells[row.user_id] = {};
    cells[row.user_id][row.topic_id] = Math.round(row.avg);
  });

  const misconceptionRows = db.prepare(`
    SELECT topic_id, misconception_tag, COUNT(*) AS n
    FROM submissions WHERE misconception_tag IS NOT NULL AND voided = 0
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

  // Any student/topic pair with a logged tab-switch/fullscreen-exit event,
  // or a submission caught in a cross-student similarity flag — flagged so
  // the heatmap cell itself can show a ⚠ without opening the drawer.
  const flaggedCells = new Set();
  db.prepare('SELECT DISTINCT user_id, topic_id FROM exam_integrity').all()
    .forEach((r) => flaggedCells.add(r.user_id + ':' + r.topic_id));
  db.prepare(`
    SELECT DISTINCT s.user_id, s.topic_id FROM similarity_flags f
    JOIN submissions s ON s.id = f.submission_id OR s.id = f.matched_submission_id
  `).all().forEach((r) => flaggedCells.add(r.user_id + ':' + r.topic_id));

  // Same idea, tracked separately so the dashboard can tell "text/tab
  // signal" apart from "webcam attention signal" at a glance (⚠ vs 🎥).
  const webcamFlaggedCells = new Set();
  db.prepare('SELECT DISTINCT user_id, topic_id FROM webcam_alerts').all()
    .forEach((r) => webcamFlaggedCells.add(r.user_id + ':' + r.topic_id));

  res.json({
    topics: topics.map(t => ({
      key: t.key, name: t.name,
      topMisconception: topMisconception[t.id] || null,
      pendingQA: pendingByTopic[t.id] || 0,
    })),
    students: students.map(s => ({
      id: s.id, name: s.display_name,
      scores: Object.fromEntries(topics.map(t => [t.key, cells[s.id][t.id] ?? null])),
      flagged: Object.fromEntries(topics.map(t => [t.key, flaggedCells.has(s.id + ':' + t.id)])),
      webcamFlagged: Object.fromEntries(topics.map(t => [t.key, webcamFlaggedCells.has(s.id + ':' + t.id)])),
    })),
  });
});

// Top misconceptions across the whole class, across ALL topics (not just one
// column's top tag) — the "what should I re-teach this week" view.
app.get('/api/instructor/misconceptions', requireRole('instructor'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.misconception_tag AS tag, t.key AS topicKey, t.name AS topicName, COUNT(*) AS n
    FROM submissions s JOIN topics t ON t.id = s.topic_id
    WHERE s.misconception_tag IS NOT NULL AND s.voided = 0
    GROUP BY s.misconception_tag, s.topic_id
    ORDER BY n DESC LIMIT 8
  `).all();
  res.json(rows);
});

app.get('/api/instructor/remediation-impact', requireRole('instructor'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.topic_id, r.before_avg, r.created_at, t.key AS topicKey, t.name AS topicName
    FROM remediations r JOIN topics t ON t.id = r.topic_id
    ORDER BY r.created_at DESC LIMIT 10
  `).all();
  const out = rows.map(r => {
    const after = db.prepare(`
      SELECT AVG(auto_score) AS avg, COUNT(*) AS n FROM submissions
      WHERE topic_id = ? AND status = 'graded' AND voided = 0 AND ts > ?
    `).get(r.topic_id, r.created_at);
    return {
      id: r.id, topicKey: r.topicKey, topicName: r.topicName, createdAt: r.created_at,
      beforeAvg: r.before_avg == null ? null : Math.round(r.before_avg),
      afterAvg: after.avg == null ? null : Math.round(after.avg),
      sinceCount: after.n,
    };
  });
  res.json(out);
});

// Everything the browser detected and logged during exams — tab-switches,
// fullscreen exits, and cross-student text-similarity matches. Detected and
// reported, never claimed to have "prevented" anything.
app.get('/api/instructor/integrity', requireRole('instructor'), (req, res) => {
  const eventRows = db.prepare(`
    SELECT ei.id, ei.exam_run, ei.events, ei.created_at, u.display_name AS studentName, t.key AS topicKey, t.name AS topicName
    FROM exam_integrity ei JOIN users u ON u.id = ei.user_id JOIN topics t ON t.id = ei.topic_id
    ORDER BY ei.created_at DESC LIMIT 20
  `).all().map((r) => ({
    kind: 'events', id: r.id, studentName: r.studentName, topicKey: r.topicKey, topicName: r.topicName,
    createdAt: r.created_at, events: parseJSON(r.events, []),
  }));

  const similarityRows = db.prepare(`
    SELECT f.id, f.similarity, f.created_at,
      ua.display_name AS studentName, ub.display_name AS matchedStudentName,
      t.key AS topicKey, t.name AS topicName, i.prompt
    FROM similarity_flags f
    JOIN submissions sa ON sa.id = f.submission_id
    JOIN submissions sb ON sb.id = f.matched_submission_id
    JOIN users ua ON ua.id = sa.user_id
    JOIN users ub ON ub.id = sb.user_id
    JOIN topics t ON t.id = sa.topic_id
    JOIN items i ON i.id = sa.item_id
    ORDER BY f.created_at DESC LIMIT 20
  `).all().map((r) => ({
    kind: 'similarity', id: r.id, studentName: r.studentName, matchedStudentName: r.matchedStudentName,
    topicKey: r.topicKey, topicName: r.topicName, prompt: r.prompt,
    similarity: Math.round(r.similarity * 100), createdAt: r.created_at,
  }));

  res.json({ events: eventRows, similarity: similarityRows });
});

// Webcam attention alerts (head turned away / eyes closed, 3+ times in one
// sitting) — each one IS the reason that exam attempt ended, a hard fail.
// If a student has a genuine excuse (network drop, technical issue) they
// take up with the instructor directly; "Grant retake" below is how that
// gets reflected in the system.
app.get('/api/instructor/webcam-alerts', requireRole('instructor'), (req, res) => {
  const rows = db.prepare(`
    SELECT wa.id, wa.strike_count, wa.snapshot, wa.created_at, wa.resolved,
      u.display_name AS studentName, t.key AS topicKey, t.name AS topicName
    FROM webcam_alerts wa
    JOIN users u ON u.id = wa.user_id
    JOIN topics t ON t.id = wa.topic_id
    ORDER BY wa.created_at DESC LIMIT 20
  `).all();
  res.json(rows.map(r => ({
    id: r.id, studentName: r.studentName, topicKey: r.topicKey, topicName: r.topicName,
    count: r.strike_count, snapshot: r.snapshot, createdAt: r.created_at, retakeGranted: !!r.resolved,
  })));
});

// Grants a retake for the exact exam attempt this alert failed: voids
// every submission from that attempt (excluded from every score/average
// from here on, but never deleted — still visible, marked voided, in the
// instructor drill-down) and unlocks the topic so the student can attempt
// it again. Tells that exact student live, wherever they're logged in.
app.post('/api/instructor/webcam-alerts/:id/grant-retake', requireRole('instructor'), (req, res) => {
  const alertId = Number(req.params.id);
  const alert = db.prepare(`
    SELECT wa.id, wa.user_id, wa.exam_run, wa.resolved, t.id AS topicId, t.key AS topicKey, t.name AS topicName,
      u.display_name AS studentName
    FROM webcam_alerts wa JOIN topics t ON t.id = wa.topic_id JOIN users u ON u.id = wa.user_id
    WHERE wa.id = ?
  `).get(alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found.' });
  if (alert.resolved) return res.json({ ok: true, alreadyGranted: true });

  db.prepare('UPDATE webcam_alerts SET resolved = 1 WHERE id = ?').run(alertId);
  db.prepare('UPDATE submissions SET voided = 1 WHERE user_id = ? AND topic_id = ? AND exam_run = ?')
    .run(alert.user_id, alert.topicId, alert.exam_run);

  io.to('user:' + alert.user_id).emit('exam:retakeGranted', { topicKey: alert.topicKey, topicName: alert.topicName });
  io.to('instructors').emit('integrity:retakeGranted', { alertId, studentId: alert.user_id, studentName: alert.studentName, topicKey: alert.topicKey });

  res.json({ ok: true });
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
  const studentId = req.params.studentId;
  const subs = db.prepare(`
    SELECT s.*, i.prompt, i.options, i.correct_index, i.keywords
    FROM submissions s JOIN items i ON i.id = s.item_id
    WHERE s.user_id = ? AND s.topic_id = ? ORDER BY s.ts DESC
  `).all(studentId, topic.id);

  const integrityEvents = db.prepare(`
    SELECT events, created_at FROM exam_integrity WHERE user_id = ? AND topic_id = ? ORDER BY created_at DESC
  `).all(studentId, topic.id).map((r) => ({ events: parseJSON(r.events, []), createdAt: r.created_at }));

  const similarityFlags = db.prepare(`
    SELECT f.similarity, f.created_at,
      CASE WHEN sa.user_id = ? THEN ub.display_name ELSE ua.display_name END AS otherStudentName
    FROM similarity_flags f
    JOIN submissions sa ON sa.id = f.submission_id
    JOIN submissions sb ON sb.id = f.matched_submission_id
    JOIN users ua ON ua.id = sa.user_id
    JOIN users ub ON ub.id = sb.user_id
    WHERE (sa.user_id = ? OR sb.user_id = ?) AND sa.topic_id = ?
    ORDER BY f.created_at DESC
  `).all(studentId, studentId, studentId, topic.id).map((r) => ({
    otherStudentName: r.otherStudentName, similarity: Math.round(r.similarity * 100), createdAt: r.created_at,
  }));

  const webcamAlerts = db.prepare(`
    SELECT id, strike_count, snapshot, created_at, resolved FROM webcam_alerts
    WHERE user_id = ? AND topic_id = ? ORDER BY created_at DESC
  `).all(studentId, topic.id).map((r) => ({
    id: r.id, count: r.strike_count, snapshot: r.snapshot, createdAt: r.created_at, retakeGranted: !!r.resolved,
  }));

  res.json({
    submissions: subs.map(s => ({
      id: s.id, type: s.type, status: s.status, autoScore: s.auto_score,
      misconceptionTag: s.misconception_tag, ts: s.ts, voided: !!s.voided,
      prompt: s.prompt,
      options: s.options ? parseJSON(s.options, []) : undefined,
      selectedIndex: s.selected_index,
      correctIndex: s.correct_index,
      responseText: s.response_text,
      keywords: s.keywords ? parseJSON(s.keywords, []) : undefined,
    })),
    integrityEvents,
    similarityFlags,
    webcamAlerts,
  });
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

app.post('/api/instructor/review', requireRole('instructor'), validate(reviewSchema), (req, res) => {
  const { submissionId, score } = req.body;
  const clamped = Math.max(0, Math.min(100, score));
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

app.post('/api/instructor/remediate', requireRole('instructor'), validate(remediateSchema), (req, res) => {
  const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(req.body.topicKey);
  if (!topic) return res.status(404).json({ error: 'Unknown topic.' });

  let missed = db.prepare(`
    SELECT item_id, COUNT(*) AS misses FROM submissions
    WHERE topic_id = ? AND type = 'quiz' AND auto_score = 0 AND voided = 0
    GROUP BY item_id ORDER BY misses DESC LIMIT 5
  `).all(topic.id).map(r => r.item_id);

  if (missed.length === 0) {
    missed = db.prepare("SELECT id FROM items WHERE topic_id = ? AND type = 'quiz' LIMIT 3").all(topic.id).map(r => r.id);
  }

  const message = `Extra practice recommended in ${topic.name} based on class results.`;
  const beforeAvg = classAverageFor(topic.id);
  const info = db.prepare('INSERT INTO remediations (topic_id, item_ids, message, before_avg) VALUES (?, ?, ?, ?)')
    .run(topic.id, JSON.stringify(missed), message, beforeAvg);

  io.to('students').emit('remediation:new', { topicKey: topic.key, topicName: topic.name, message });

  res.json({ id: info.lastInsertRowid, itemIds: missed, message });
});

// ---------- Socket.IO ----------
// userId -> Set of live socket ids (a student can have >1 tab open)
const onlineStudents = new Map();
// userId -> { studentId, studentName, topicKey, topicName, answered, total, quizTrail, examRun } while an exam is in progress
const activeExams = new Map();
const getQuizCorrectIndex = db.prepare("SELECT correct_index FROM items WHERE id = ? AND type = 'quiz'");

// `${userId}:${topicId}:${examRun}` -> true, once an instructor email has
// gone out for that sitting. Keeps a long exam with many strikes from
// spamming the instructor's inbox — the dashboard still logs every strike,
// email just fires once per exam attempt.
const webcamAlertEmailed = new Set();
function clearWebcamEmailFlags(userId) {
  const prefix = `${userId}:`;
  [...webcamAlertEmailed].forEach((key) => { if (key.startsWith(prefix)) webcamAlertEmailed.delete(key); });
}

function broadcastOnline() {
  // Both rooms care: instructors see it as a headcount, students see it as
  // an anonymized "N classmates online now" — same number, same event.
  io.emit('presence:online', { count: onlineStudents.size });
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
  // A private room for exactly this student — used to notify them live
  // (e.g. a retake being granted) on whichever tab they're actually using.
  socket.join('user:' + userId);
  broadcastOnline();

  socket.on('exam:start', ({ topicKey, topicName, total }) => {
    const state = { studentId: userId, studentName: name, topicKey, topicName, answered: 0, total: total || 0, quizTrail: [], examRun: Date.now() };
    activeExams.set(userId, state);
    io.to('instructors').emit('presence:progress', state);
  });

  socket.on('exam:progress', ({ answered }) => {
    const state = activeExams.get(userId);
    if (!state) return;
    state.answered = answered;
    io.to('instructors').emit('presence:progress', state);
  });

  // Quiz items only — grade server-side the instant an option is picked and
  // relay just a correct/incorrect flag. Task/Q&A have no objective answer
  // until they're graded, so there's nothing meaningful to show live for those.
  socket.on('exam:answer', ({ itemId, selectedIndex }) => {
    const state = activeExams.get(userId);
    const item = getQuizCorrectIndex.get(itemId);
    if (!state || !item) return;
    const correct = Number(selectedIndex) === item.correct_index;
    if (!state.quizTrail) state.quizTrail = [];
    const existing = state.quizTrail.findIndex((q) => q.itemId === itemId);
    if (existing >= 0) state.quizTrail[existing] = { itemId, correct };
    else state.quizTrail.push({ itemId, correct });
    io.to('instructors').emit('presence:progress', state);
  });

  // Webcam attention monitoring: entirely client-side face-landmark
  // detection (see public/student/webcam-monitor.js) — no video is ever
  // sent here, only a strike count and, once 3+ strikes are reached, one
  // small still-frame snapshot. A browser-side estimate, not proof.
  //
  // The 3rd strike ends the exam immediately — the student's own client
  // force-submits it as a hard fail right after emitting this (see
  // startWebcamMonitor in public/student/app.js). This handler's only job
  // is recording the strike and telling the instructor it happened.
  socket.on('exam:webcamAlert', ({ topicKey, count, snapshot }) => {
    const state = activeExams.get(userId);
    if (!state) return;
    const topic = db.prepare('SELECT * FROM topics WHERE key = ?').get(topicKey);
    if (!topic || !Number.isInteger(count) || count < 3) return;
    // Cap defensively — a legitimate low-res/low-quality JPEG snapshot is a
    // few tens of KB as base64; anything past this is dropped, not stored.
    const safeSnapshot = (typeof snapshot === 'string' && snapshot.length > 0 && snapshot.length <= 300000) ? snapshot : null;
    const examRun = state.examRun || Date.now();

    const inserted = db.prepare('INSERT INTO webcam_alerts (user_id, topic_id, exam_run, strike_count, snapshot) VALUES (?, ?, ?, ?, ?)')
      .run(userId, topic.id, examRun, count, safeSnapshot);

    const payload = {
      alertId: inserted.lastInsertRowid,
      studentId: userId, studentName: name, topicKey: topic.key, topicName: topic.name,
      count, snapshot: safeSnapshot, ts: Date.now(),
    };
    io.to('instructors').emit('integrity:webcamAlert', payload);

    const sessionKey = `${userId}:${topic.id}:${examRun}`;
    if (!webcamAlertEmailed.has(sessionKey)) {
      webcamAlertEmailed.add(sessionKey);
      sendWebcamAlertEmail({ studentName: name, topicName: topic.name, count, ts: payload.ts, snapshotDataUrl: safeSnapshot })
        .catch((err) => console.error('webcam alert email failed:', err.message));
    }
  });

  socket.on('disconnect', () => {
    const set = onlineStudents.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      onlineStudents.delete(userId);
      activeExams.delete(userId);
      clearWebcamEmailFlags(userId);
      io.to('instructors').emit('presence:clear', { studentId: userId });
    }
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
// Only actually bind a port when this file is run directly (`node
// server/server.js` / `npm start`) — not when a test file requires `app` to
// drive it with supertest, which would otherwise leave a real listener on
// :3000 fighting with dev servers and other test files for the port.
if (require.main === module) {
  server.listen(PORT, () => console.log(`Mastery Pulse server listening on ${PORT}`));
}

module.exports = { app, server, io };
