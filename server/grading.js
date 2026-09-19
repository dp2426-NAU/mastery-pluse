// Grading is pulled out of server.js so it can be unit-tested directly,
// without spinning up Express or a socket connection.
const db = require('./db');
const { jaccardSimilarity, isComparable, SIMILARITY_THRESHOLD } = require('./similarity');

const parseJSON = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// 90s/item, floor of 4 minutes so a short remediation set isn't a 45-second sprint.
function timeLimitFor(itemCount) {
  return Math.max(240, itemCount * 90);
}

function topicScoreFor(userId, topicId) {
  const row = db.prepare(`
    SELECT AVG(auto_score) AS avg FROM submissions
    WHERE user_id = ? AND topic_id = ? AND status = 'graded' AND voided = 0
  `).get(userId, topicId);
  return row.avg == null ? null : Math.round(row.avg);
}

function classAverageFor(topicId) {
  const row = db.prepare(`
    SELECT AVG(auto_score) AS avg FROM submissions WHERE topic_id = ? AND status = 'graded' AND voided = 0
  `).get(topicId);
  return row.avg == null ? null : Math.round(row.avg);
}

// Compares a just-submitted free-text answer against every other student's
// prior answer to the SAME item, flags high-overlap pairs for instructor
// review, and returns what it flagged (for the live socket notification).
function checkSimilarity(itemId, submissionId, userId, text) {
  if (!isComparable(text)) return [];
  const others = db.prepare(`
    SELECT s.id, s.response_text, u.display_name AS studentName
    FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.item_id = ? AND s.user_id != ? AND s.id != ? AND s.response_text IS NOT NULL
  `).all(itemId, userId, submissionId);

  const insertFlag = db.prepare('INSERT INTO similarity_flags (submission_id, matched_submission_id, similarity) VALUES (?, ?, ?)');
  const flagged = [];
  for (const other of others) {
    const similarity = jaccardSimilarity(text, other.response_text);
    if (similarity >= SIMILARITY_THRESHOLD) {
      insertFlag.run(submissionId, other.id, similarity);
      flagged.push({ itemId, matchedStudentName: other.studentName, similarity: Math.round(similarity * 100) });
    }
  }
  return flagged;
}

// examRunOverride lets the caller pin this attempt's exam_run to the same
// value already established when the exam started (see activeExams in
// server.js) — matters because webcam_alerts rows are written against
// THAT exam_run, and a later "grant retake" needs to void the exact same
// attempt's submissions by matching on it. Falls back to a fresh
// timestamp for any caller that never had a live exam:start (e.g. tests
// driving the REST API directly).
function gradeAndStore(userId, topicId, responses, examRunOverride) {
  const examRun = examRunOverride || Date.now();
  const results = [];
  const similarityFlags = [];
  const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO submissions (user_id, topic_id, item_id, type, selected_index, response_text, auto_score, misconception_tag, confidence, status, exam_run)
    VALUES (@user_id, @topic_id, @item_id, @type, @selected_index, @response_text, @auto_score, @misconception_tag, @confidence, @status, @exam_run)
  `);

  for (const r of responses) {
    const item = getItem.get(r.itemId);
    if (!item || item.topic_id !== topicId) continue;

    const confidence = Number.isFinite(Number(r.confidence)) ? Math.max(1, Math.min(5, Number(r.confidence))) : null;

    let row = {
      user_id: userId, topic_id: topicId, item_id: item.id, type: item.type,
      selected_index: null, response_text: null, auto_score: null,
      misconception_tag: null, confidence, status: 'graded', exam_run: examRun,
    };

    if (item.type === 'quiz') {
      const options = parseJSON(item.options, []);
      const misconceptions = parseJSON(item.misconceptions, []);
      const selected = Number(r.selectedIndex);
      const correct = selected === item.correct_index;
      row.selected_index = selected;
      row.auto_score = correct ? 100 : 0;
      row.misconception_tag = correct ? null : (misconceptions[selected] || null);
      results.push({ itemId: item.id, type: 'quiz', correct, correctIndex: item.correct_index, options, question: item.prompt, confidence });
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

    const inserted = insert.run(row);

    // Free-text answers only — a wrong quiz pick has no "text" to compare.
    if ((item.type === 'task' || item.type === 'qa') && row.response_text) {
      similarityFlags.push(...checkSimilarity(item.id, inserted.lastInsertRowid, userId, row.response_text));
    }
  }
  // Attached as extra properties rather than changing the return shape —
  // existing callers destructuring `[result] = gradeAndStore(...)` or
  // iterating the array keep working unchanged.
  results.examRun = examRun;
  results.similarityFlags = similarityFlags;
  return results;
}

module.exports = { parseJSON, timeLimitFor, topicScoreFor, classAverageFor, gradeAndStore };
