// Grading is pulled out of server.js so it can be unit-tested directly,
// without spinning up Express or a socket connection.
const db = require('./db');

const parseJSON = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// 90s/item, floor of 4 minutes so a short remediation set isn't a 45-second sprint.
function timeLimitFor(itemCount) {
  return Math.max(240, itemCount * 90);
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

function gradeAndStore(userId, topicId, responses) {
  const examRun = Date.now();
  const results = [];
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

    insert.run(row);
  }
  return results;
}

module.exports = { parseJSON, timeLimitFor, topicScoreFor, classAverageFor, gradeAndStore };
