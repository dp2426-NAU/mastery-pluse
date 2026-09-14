const path = require('path');
const Database = require('better-sqlite3');

// DB_PATH lets tests point this at ':memory:' (or a throwaway file) instead
// of the real dev/prod database — set it before this module is first
// required, since the connection opens immediately below.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'mastery-pulse.db');
const db = new Database(dbPath);
if (dbPath !== ':memory:') db.pragma('journal_mode = WAL'); // WAL needs a real file on disk

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
  confidence INTEGER,         -- 1-5, student's self-rated confidence at answer time
  status TEXT NOT NULL DEFAULT 'graded' CHECK(status IN ('graded','pending_review')),
  exam_run INTEGER NOT NULL,  -- groups items submitted together as one exam
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS remediations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  item_ids TEXT NOT NULL, -- JSON array of item ids
  message TEXT NOT NULL,
  before_avg REAL,         -- class average for the topic at the moment remediation was sent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Browser-detected integrity signals for one exam attempt (tab left,
-- fullscreen exited). Detected and logged, never claimed to "prevent"
-- anything -- a browser genuinely cannot stop a tab being closed.
CREATE TABLE IF NOT EXISTS exam_integrity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  exam_run INTEGER NOT NULL,
  events TEXT NOT NULL, -- JSON array of {type, ts}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-student free-text similarity, computed the instant a task/Q&A
-- response is submitted, against every prior response to the same item.
CREATE TABLE IF NOT EXISTS similarity_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  matched_submission_id INTEGER NOT NULL REFERENCES submissions(id),
  similarity REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Lightweight migration: CREATE TABLE IF NOT EXISTS won't add columns to a
// table that already existed under an older schema (e.g. a dev's local db
// file from before this column was added). Patch it in if missing.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('submissions', 'confidence', 'confidence INTEGER');
ensureColumn('remediations', 'before_avg', 'before_avg REAL');

module.exports = db;
