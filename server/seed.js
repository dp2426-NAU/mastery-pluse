const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

const TOPICS = [
  { key: 'cybersecurity', name: 'Cybersecurity' },
  { key: 'web-technology', name: 'Web Technology' },
  { key: 'networking', name: 'Networking' },
  { key: 'cloud-computing', name: 'Cloud Computing' },
  { key: 'full-stack', name: 'Full Stack Development' },
];

const DEMO_USERS = [
  { username: 'prof.demo', password: 'MasterClass#2026', role: 'instructor', display_name: 'Prof. Demo' },
  { username: 'student1', password: 'Pulse#Student1', role: 'student', display_name: 'Aiden Cross' },
  { username: 'student2', password: 'Pulse#Student2', role: 'student', display_name: 'Maria Okafor' },
  { username: 'student3', password: 'Pulse#Student3', role: 'student', display_name: 'Ravi Shah' },
  { username: 'student4', password: 'Pulse#Student4', role: 'student', display_name: 'Wei Zhang' },
  { username: 'student5', password: 'Pulse#Student5', role: 'student', display_name: 'Fatima Ali' },
  { username: 'student6', password: 'Pulse#Student6', role: 'student', display_name: 'Lucas Bianchi' },
  { username: 'student7', password: 'Pulse#Student7', role: 'student', display_name: 'Sofia Petrova' },
  { username: 'student8', password: 'Pulse#Student8', role: 'student', display_name: 'Daniel Kim' },
  { username: 'student9', password: 'Pulse#Student9', role: 'student', display_name: 'Emma Johansson' },
  { username: 'student10', password: 'Pulse#Student10', role: 'student', display_name: 'Noah Fernandez' },
];

function seed() {
  const insertTopic = db.prepare('INSERT OR IGNORE INTO topics (key, name) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const t of TOPICS) insertTopic.run(t.key, t.name);

    const getTopicId = db.prepare('SELECT id FROM topics WHERE key = ?');
    const countItems = db.prepare('SELECT COUNT(*) AS c FROM items WHERE topic_id = ?');
    const insertItem = db.prepare(`
      INSERT INTO items (topic_id, type, tier, prompt, options, correct_index, misconceptions, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const t of TOPICS) {
      const topicId = getTopicId.get(t.key).id;
      if (countItems.get(topicId).c > 0) continue;
      const file = path.join(__dirname, 'topics', `${t.key}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));

      for (const q of data.quiz || []) {
        insertItem.run(topicId, 'quiz', q.tier, q.question, JSON.stringify(q.options), q.correctIndex, JSON.stringify(q.misconceptions || []), null);
      }
      for (const task of data.task || []) {
        insertItem.run(topicId, 'task', null, task.prompt, null, null, null, JSON.stringify(task.keywords || []));
      }
      for (const qa of data.qa || []) {
        insertItem.run(topicId, 'qa', null, qa.prompt, null, null, null, null);
      }
    }

    const insertUser = db.prepare(
      'INSERT OR IGNORE INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)'
    );
    for (const u of DEMO_USERS) {
      insertUser.run(u.username, bcrypt.hashSync(u.password, 10), u.role, u.display_name);
    }
  });
  tx();
  console.log('Seed complete.');
  console.log('Demo credentials:');
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(10)} ${u.username} / ${u.password}`);
}

seed();
