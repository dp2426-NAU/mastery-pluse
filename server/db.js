const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'mastery-pulse.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','instructor')),
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- type: 'quiz' | 'task' | 'qa'
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  type TEXT NOT NULL CHECK(type IN ('quiz','task','qa')),
  tier INTEGER,
  prompt TEXT NOT NULL,
  options TEXT,          -- JSON array, quiz only
  correct_index INTEGER, -- quiz only
  misconceptions TEXT,   -- JSON array parallel to options, quiz only
  keywords TEXT          -- JSON array, task only
);

-- One row per item per exam submission.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  type TEXT NOT NULL,
  selected_index INTEGER,     -- quiz
  response_text TEXT,         -- task / qa
  auto_score INTEGER,         -- 0-100, null until graded (qa starts null)
  misconception_tag TEXT,     -- quiz, only set when wrong
  status TEXT NOT NULL DEFAULT 'graded' CHECK(status IN ('graded','pending_review')),
  exam_run INTEGER NOT NULL,  -- groups items submitted together as one exam
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS remediations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  item_ids TEXT NOT NULL, -- JSON array of item ids
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
