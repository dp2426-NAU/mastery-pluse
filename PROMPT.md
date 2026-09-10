# Master Build Prompt — Mastery Pulse

Paste this into Antigravity, Claude Code, or any AI coding agent connected to your IDE to regenerate, extend, or modify this project.

---

## Project

Build **Mastery Pulse**, a real-time exam platform for a graduate-level IT/CS course, covering five topics: **Cybersecurity, Web Technology, Networking, Cloud Computing, and Full Stack Development**. A student takes an exam per topic — a mix of multiple-choice quiz questions, short open-ended Q&A, and practical tasks — and submits it. The instant they submit, the instructor's dashboard updates with a live weak-topic heatmap showing exactly which topics that student (and the class as a whole) is struggling with.

This is a course project for "Designing a Client-Server Architecture for Web Applications," so the architecture is itself a deliverable: clean client/server/data separation, a real-time channel (Socket.IO), and role-based access control.

## Roles & authentication (completely separate)

Two roles, two login screens, two UIs, two sets of credentials:
- **Student panel** (`/student`) — takes exams, sees own results and a class-average comparison per topic.
- **Instructor panel** (`/instructor`) — never answers questions; only sees the heatmap, per-student drill-downs, and a pending-review queue.

Passwords are bcrypt-hashed. JWTs carry the role in their claims. Middleware and the Socket.IO handshake both reject a token used against the wrong role's routes/room.

## The three exam item types, and how each is graded

1. **Quiz** (multiple choice) — auto-graded instantly against `correct_index`. Each wrong option carries a `misconception` tag (e.g. `inverts-least-privilege`) so the system knows not just that an answer was wrong, but what specific misunderstanding it reveals.
2. **Task** (open-ended, practical) — auto-graded by keyword/rubric coverage: the item defines expected `keywords`, and the score is the percentage of those keywords present in the student's response. This keeps grading real-time without needing full NLP.
3. **Q&A** (short free-text) — NOT auto-graded. Saved with `status: 'pending_review'`, surfaced in an instructor review queue. The instructor assigns a score, which then folds into that student's topic average. This is a deliberate trade-off: full-text grading is hard to do reliably with simple code, so accuracy is chosen over real-time-ness for this one item type, while quiz + task stay fully real-time.

A topic score for a student is the average of their graded (quiz + task) submissions for that topic.

## The signature features (no 3D — explicitly ruled out)

- **Weak-topic heatmap**: students × topics grid, color-coded by score (red/amber/green), live-updating as exams are submitted. Click a cell to drill into exactly which quiz questions were missed (with misconception tag), how a task scored against its rubric, and any Q&A pending or already reviewed.
- **Misconception aggregation**: each topic's column header shows the single most common misconception tag across the whole class for that topic, with a count — so the instructor sees not just "networking scores are low" but "most students are confusing TCP and UDP."
- **One-click remediation**: an instructor can click "Remediate" on any topic; the server finds the most-missed quiz questions in that topic across the class, bundles them into a remediation set, and broadcasts it — students see a banner on their dashboard offering to practice exactly those questions.
- **Peer-anonymous benchmarking**: after submitting an exam, a student sees their own score next to the anonymized class average for that topic — no other student is identified.

## Stack

Node.js + Express + Socket.IO + better-sqlite3 (swap to `pg` for deployed Postgres without changing the schema). Plain HTML/CSS/JS on the client, no framework. No paid APIs, no cloud-provider dependency; deployable on Render's free tier. Any third-party script (e.g. Socket.IO's client) should be served from the app itself, not a public CDN — a live classroom demo shouldn't depend on the venue's Wi-Fi reaching an external host.

## Deliverables

1. `server/` — `server.js`, `auth.js`, `db.js`, `seed.js`, `topics/*.json` (quiz + task + qa items per topic).
2. `public/student/` — login + exam-taking UI (all three item types) + results/benchmarking view + remediation banner.
3. `public/instructor/` — login + heatmap dashboard + drill-down drawer + pending Q&A review queue + remediate button.
4. `README.md` and `render.yaml`.

## Acceptance checklist

- A student can take a mixed-type exam and submit it in one action.
- The instructor's heatmap cell for that student/topic updates within about a second, with no refresh.
- Clicking a heatmap cell shows exactly which items were missed, including the misconception tag for wrong quiz answers.
- A Q&A submission does not block the quiz/task score from appearing, and grading it from the review queue updates the heatmap live.
- Clicking "Remediate" on a topic results in a banner appearing on student dashboards for that topic.
- An instructor token cannot call any `/api/student/*` route and vice versa.
