// Populates realistic exam activity for the seeded demo students, without
// going through the student UI at all. Useful for checking what the
// instructor dashboard looks like (heatmap, misconception leaderboard,
// pending Q&A queue, remediation impact) before a live demo.
//
// Run AFTER `npm run seed` (or just run this — it requires seed.js first,
// which is idempotent). Safe to re-run: it only ever adds more submissions,
// same as students retaking exams for real.
//
//   npm run seed:demo

require('./seed'); // ensures topics/items/users exist (idempotent)
const db = require('./db');

const STUDENT_USERNAMES = ['student1', 'student2', 'student3', 'student4', 'student5', 'student6', 'student7', 'student8'];
// student9 / student10 are left untouched on purpose, so the heatmap shows
// a realistic mix of attempted and "—" (not attempted) cells.

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19); }

const getStudents = db.prepare("SELECT * FROM users WHERE role = 'student' AND username IN (" + STUDENT_USERNAMES.map(() => '?').join(',') + ")");
const getTopics = db.prepare('SELECT * FROM topics ORDER BY id');
const getItems = db.prepare('SELECT * FROM items WHERE topic_id = ? ORDER BY type, id');
const insertSub = db.prepare(`
  INSERT INTO submissions (user_id, topic_id, item_id, type, selected_index, response_text, auto_score, misconception_tag, confidence, status, exam_run, ts)
  VALUES (@user_id, @topic_id, @item_id, @type, @selected_index, @response_text, @auto_score, @misconception_tag, @confidence, @status, @exam_run, @ts)
`);
const insertRemediation = db.prepare('INSERT INTO remediations (topic_id, item_ids, message, before_avg, created_at) VALUES (?, ?, ?, ?, ?)');
const classAverageFor = (topicId) => {
  const row = db.prepare("SELECT AVG(auto_score) avg FROM submissions WHERE topic_id = ? AND status = 'graded'").get(topicId);
  return row.avg == null ? null : Math.round(row.avg);
};

function parseJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

function submitFakeExam(user, topic, items, { skill, confidenceBias, ts, gradeQA }) {
  const examRun = Date.now() + Math.floor(rand(0, 1000));
  items.forEach((item) => {
    let row = {
      user_id: user.id, topic_id: topic.id, item_id: item.id, type: item.type,
      selected_index: null, response_text: null, auto_score: null,
      misconception_tag: null, confidence: null, status: 'graded', exam_run: examRun, ts,
    };

    // Confidence: mostly tracks skill, with occasional "confidently wrong"
    // outliers so the calibration flag has something to show.
    const overconfident = Math.random() < 0.12;
    row.confidence = Math.max(1, Math.min(5, Math.round((overconfident ? 4.5 : skill * 5) + confidenceBias + rand(-0.8, 0.8))));

    if (item.type === 'quiz') {
      const options = parseJSON(item.options, []);
      const misconceptions = parseJSON(item.misconceptions, []);
      const correct = Math.random() < skill;
      let selected = item.correct_index;
      if (!correct) {
        // Bias toward one consistent wrong option per item so a real
        // "most common misconception" pattern emerges, instead of noise.
        const wrongIndices = options.map((_, i) => i).filter((i) => i !== item.correct_index);
        selected = wrongIndices[0] ?? wrongIndices[Math.floor(Math.random() * wrongIndices.length)];
        if (Math.random() < 0.25) selected = pick(wrongIndices); // some noise, not every student makes the same mistake
      }
      row.selected_index = selected;
      row.auto_score = selected === item.correct_index ? 100 : 0;
      row.misconception_tag = selected === item.correct_index ? null : (misconceptions[selected] || null);
    } else if (item.type === 'task') {
      const keywords = parseJSON(item.keywords, []);
      const howMany = Math.max(0, Math.round(keywords.length * skill));
      const used = keywords.slice(0, howMany);
      row.response_text = used.length ? `Approach: ${used.join(', ')}.` : 'Not sure how to approach this one.';
      row.auto_score = keywords.length ? Math.round((used.length / keywords.length) * 100) : 0;
    } else { // qa
      row.response_text = `${user.display_name}'s answer, in their own words, touching on the key idea the prompt asks about.`;
      if (gradeQA) {
        row.status = 'graded';
        row.auto_score = Math.round(skill * 100);
      } else {
        row.status = 'pending_review';
      }
    }
    insertSub.run(row);
  });
}

function run() {
  const students = getStudents.all(...STUDENT_USERNAMES);
  const topics = getTopics.all();
  if (!students.length) { console.error('No demo students found — run `npm run seed` first.'); process.exit(1); }

  const tx = db.transaction(() => {
    students.forEach((student, si) => {
      // Each student has a per-topic "skill" so the heatmap shows real
      // variance — someone strong in Networking, weak in Cybersecurity, etc.
      topics.forEach((topic, ti) => {
        // Not every student attempts every topic — leaves some "—" cells.
        if (Math.random() < 0.15) return;

        const items = getItems.all(topic.id);
        const skill = Math.max(0.15, Math.min(0.97, rand(0.3, 0.95) + Math.sin(si + ti) * 0.15));
        const gradeQA = Math.random() < 0.4; // leave most Q&A pending, so the review queue has real content

        submitFakeExam(student, topic, items, { skill, confidenceBias: 0, ts: hoursAgo(rand(3, 30)), gradeQA });

        // ~1 in 3 students who attempted a topic also retake it later,
        // usually a bit stronger the second time — mirrors real usage and
        // gives the misconception/heatmap numbers more texture.
        if (Math.random() < 0.3) {
          submitFakeExam(student, topic, items, { skill: Math.min(0.97, skill + rand(0.05, 0.2)), confidenceBias: 0.5, ts: hoursAgo(rand(0.5, 2)), gradeQA: Math.random() < 0.5 });
        }
      });
    });

    // Seed one remediation (with a real "before" average) for the two
    // weakest-looking topics, backdated, then a fresh post-remediation
    // wave of submissions so the impact tracker shows a populated
    // before -> after delta immediately instead of "awaiting submissions."
    const topicAverages = topics.map((t) => ({ topic: t, avg: classAverageFor(t.id) })).filter((x) => x.avg != null);
    topicAverages.sort((a, b) => a.avg - b.avg);
    topicAverages.slice(0, 2).forEach(({ topic }) => {
      const beforeAvg = classAverageFor(topic.id);
      const missed = db.prepare(`
        SELECT item_id FROM submissions WHERE topic_id = ? AND type = 'quiz' AND auto_score = 0
        GROUP BY item_id ORDER BY COUNT(*) DESC LIMIT 5
      `).all(topic.id).map((r) => r.item_id);
      const remediatedAt = hoursAgo(1);
      insertRemediation.run(topic.id, JSON.stringify(missed), `Extra practice recommended in ${topic.name} based on class results.`, beforeAvg, remediatedAt);

      // A few students improve after the remediation.
      const items = getItems.all(topic.id);
      students.slice(0, 4).forEach((student, i) => {
        submitFakeExam(student, topic, items, { skill: Math.min(0.95, 0.55 + i * 0.1), confidenceBias: 0.5, ts: hoursAgo(0.1), gradeQA: true });
      });
    });
  });
  tx();

  console.log(`Demo activity seeded for ${students.length} students across ${topics.length} topics.`);
  console.log('Open the instructor dashboard now — heatmap, misconception leaderboard, pending Q&A queue, and remediation impact should all be populated.');
}

run();
