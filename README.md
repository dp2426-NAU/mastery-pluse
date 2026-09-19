# Mastery Pulse

![CI](https://github.com/dp2426-NAU/mastery-pluse/actions/workflows/ci.yml/badge.svg)

A real-time exam platform for a graduate IT/CS course, covering **Cybersecurity, Web Technology, Networking, Cloud Computing, and Full Stack Development**. Students take a mixed-format exam per topic — quiz, task, and short-answer Q&A — and the moment they submit, the instructor's dashboard shows a live weak-topic heatmap: exactly which topics that student, and the class as a whole, are struggling with.

Built for the course topic **"Designing a Client-Server Architecture for Web Applications."**

## Exam integrity

Three real, honest features — no fake "AI-detector," since those (Turnitin, GPTZero, etc.) are unreliable paid services that produce real false accusations against genuine student writing:

- **One-way answer lock**: exams are one question at a time. Once you move to the next question, the previous one is locked — no going back to change an answer, same as a real proctored exam.
- **Integrity event trail**: the browser detects and logs tab-switches and fullscreen exits during an exam, timestamped, shown to the instructor per submission. This is *detected and logged*, never claimed to *prevent* anything — no website can actually stop someone from closing a tab, and this doesn't pretend otherwise.
- **Cross-student answer-similarity detection**: every free-text answer (task/Q&A) is compared, the instant it's submitted, against every other student's answer to the same question using word-set Jaccard similarity — explainable, deterministic math, not a black-box model. A pair above 60% overlap is flagged live for instructor review ("91% overlap with Maria Okafor's answer"), and the affected heatmap cells get a ⚠ badge.

## Webcam proctoring alerts

A fourth integrity signal, alongside the answer lock, event trail, and similarity detection above — this one uses the camera.

- **Fully client-side detection.** The moment a student starts an exam (after a one-time consent notice), their browser runs [MediaPipe's Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) — a face-landmark model that downloads and runs entirely inside the tab via WebAssembly. It estimates head yaw (is the face turned away?) and eye closure roughly twice a second. **No video is ever recorded, streamed, or uploaded** — that would need a media server and raises real consent/privacy problems for a university deployment neither warranted nor needed here.
- **3-strike threshold, and the student is never kept in the dark about it.** A sustained look-away or eyes-closed moment counts as one "strike," debounced so a single long turn isn't ten strikes. The 1st and 2nd strike show the student a private on-screen reminder only — nothing leaves their browser. Only the 3rd strike (and every one after) actually notifies the instructor: the browser sends the server `{studentName, topic, count, timestamp}` plus one small compressed snapshot, and the student is told, in that same moment, that their instructor was just notified. No strike is ever counted against a student without them seeing it happen.
- **Instant dashboard alert + optional email.** The instructor's dashboard gets a live "🎥 Proctoring Alerts" card (toast, sound, flash, same as the other live events), the flagged heatmap cell gets a 🎥 badge, and the drill-down drawer shows the snapshot in context. If `RESEND_API_KEY` and `ALERT_TO_EMAIL` are set (see `.env.example`), the instructor also gets a real email — once per exam sitting, not once per strike.
- **Honest about its limits.** This is head-pose/eye-closure *approximation*, not eye-tracking — lighting, webcam angle, and glasses all affect it. It's framed everywhere (dashboard copy, email body, this README) as a signal to look closer, never a verdict — the same "detected and logged, not proven" honesty as the rest of the integrity features. A student who declines the camera (or has none) simply continues the exam; the instructor sees no webcam signal for that attempt instead of a hard block.

No installation is required for this: the face-detection library loads from a CDN at exam time, and email uses Resend's plain HTTP API via Node's built-in `fetch` — no SDK dependency added to `package.json`. See `.env.example` for the two optional environment variables that turn email alerts on.

## Why two completely separate panels

Students and instructors are different roles with different data access, so they get different logins, different UIs, and different API permissions — not one screen with a toggle. A student's JWT cannot call any `/api/instructor/*` route, and vice versa (see `server/auth.js`).

## The three exam item types

| Type | How it's graded |
|---|---|
| **Quiz** (multiple choice) | Auto-graded instantly. Each wrong option is tagged with the misconception it reveals. |
| **Task** (practical/open-ended) | Auto-graded by keyword/rubric coverage — the percentage of expected concepts present in the response. |
| **Q&A** (short free text) | Not auto-graded — saved as "pending review" and scored by the instructor from a review queue, which then folds into the student's topic average. |

This is a deliberate mixed-grading design: quiz and task stay fully real-time, while Q&A trades real-time-ness for accuracy, since reliably auto-grading free text is a genuinely hard problem.

## Run it locally

```bash
npm install
npm run seed        # creates the SQLite DB, topics/items, and demo accounts
npm run seed:demo   # optional: populates realistic scores/misconceptions/pending Q&A
                     # without taking any exams through the UI — see below
npm start            # starts the server on http://localhost:3000
```

### Seeing a populated instructor dashboard without taking exams yourself

`npm run seed:demo` inserts realistic submissions directly into the database for 8 of the 10 demo students, across all 5 topics — varied per-student/per-topic scores, a natural spread of misconceptions (so the leaderboard has real rankings), a pending Q&A queue, and one remediation-with-before/after-impact already recorded per weak topic. `student9` and `student10` are left untouched so the heatmap still shows a realistic mix of attempted and "—" cells. It's safe to re-run — it only adds more activity, same as students retaking exams for real.

## Demo credentials

| Role | Username | Password |
|---|---|---|
| Instructor | `prof.demo` | `MasterClass#2026` |
| Student | `student1` … `student10` | `Pulse#Student1` … `Pulse#Student10` |

(Same pattern for all ten: `studentN` / `Pulse#StudentN`.)

## Testing, validation, and hardening

This isn't just manually-clicked-through — the grading engine, role-based access control, input handling, and the real-time channel all have automated tests that actually exercise the running app, not mocks.

```bash
npm test
```

62 tests across 7 suites, run on every push via GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

- **`tests/grading.test.js`** — unit tests against the real seeded content (`server/grading.js`): correct/wrong quiz scoring, the misconception tag mapped to the *specific* wrong option chosen, keyword-coverage scoring for tasks, confidence clamping, and confirming a pending Q&A never counts toward a topic average.
- **`tests/auth.test.js`** — login success/failure paths, and `requireRole()` middleware rejecting a wrong-role token before a route handler ever runs.
- **`tests/api.test.js`** — integration tests via `supertest` against the real Express app: cross-role rejection (an instructor token really can't call `/api/student/*`, and vice versa — this is the acceptance-checklist item, verified, not asserted), input validation returning 400s on malformed bodies, and a full mixed-type submit flow.
- **`tests/realtime.test.js`** — a real HTTP server on an ephemeral port with real `socket.io-client` connections: a forged token gets rejected at the handshake, `exam:submitted` reaches an open instructor socket, a live quiz pick shows up as `presence:progress` before submission, and `remediation:new` reaches an open student socket.
- **`tests/similarity.test.js`** — calibrates the word-set Jaccard threshold against real copy-paste vs. independently-worded example answers.
- **`tests/integrity.test.js`** — drives the real submit flow to verify cross-student similarity flagging, heatmap marking, that flags never leak into a student's own submit response, and integrity-event storage.
- **`tests/webcam-alert.test.js`** — real socket connections proving a 3rd-strike webcam alert reaches the instructor live, gets stored, marks the heatmap and drill-down, that sub-threshold strikes are ignored, and that an oversized snapshot payload is dropped without losing the strike record.

Two more layers beyond tests:
- **Input validation** ([server/validation.js](server/validation.js), via `zod`) — every request body is checked against a schema before the route handler runs; a malformed request gets a specific 400, not a 500 or silent bad behavior.
- **Rate limiting** ([server/rate-limit.js](server/rate-limit.js)) — login attempts are capped (defends against brute-forcing a password) and exam submissions are capped (defends against a scripted spam loop), both disabled automatically under `NODE_ENV=test` so the test suite isn't throttled.

`GET /health` returns `{ ok: true }` unauthenticated, for uptime checks (Render, UptimeRobot, etc.) without needing a real login.

Open the instructor dashboard in one tab and a student login in another (or incognito) to watch the heatmap update live as exams are submitted.

## Proving it's a live app, not a form

Everything below fires over the same Socket.IO connection used for the heatmap — there's no polling, no refresh button.

- **Live-while-typing progress**: the instant a student opens an exam, the instructor dashboard shows a presence chip — `Aiden Cross — Networking (3/8)` — that advances with every question answered, *before* the student submits. For quiz questions specifically, a row of ✓/✗ dots grows next to their name too — each one graded server-side the instant it's picked, so the instructor can watch right/wrong happen live, not just "answered." (Task and Q&A items don't get this — there's no objective right answer to flash until they're actually graded.)
- **Flash + toast on every change**: a submission doesn't just silently update a number. The exact heatmap cell that changed glows, and a toast slides in ("Aiden Cross submitted Networking — 62%"), so a live update is impossible to miss mid-demo.
- **Live activity feed**: a scrolling ticker on the instructor dashboard logs every submission and every Q&A grade the moment it happens, each with a timestamp.
- **Connection badge**: both panels show a `● Live` / `● Reconnecting…` badge in the top bar, so you can point at proof the socket is actually connected.
- **"N students online"**: the instructor dashboard shows a live count of connected students, ticking up/down as they log in and out.
- **Live remediation**: when an instructor clicks Remediate, the banner appears on an already-open student dashboard immediately (with a toast), not on next page load.

If you're demoing this for a grader: open the instructor dashboard and a student login side by side, start an exam as the student, and narrate the progress chip moving before you even submit.

### Opening multiple logins side by side

Sessions are kept in `sessionStorage`, not `localStorage`, specifically so this works: open a **new tab** (Ctrl/Cmd+T, not "duplicate tab") for each identity you want live at once — one instructor plus several students is the standard demo setup. Each tab keeps its own independent login; logging into `student2` in one tab won't kick out `student1` in another.

## Extra features

- **Live exam timer**: every exam has a countdown (90s/item, 4-minute floor) that auto-submits whatever's answered when it hits zero — turns a form into something with real stakes.
- **Confidence self-rating**: each question asks "how sure are you?" (1-5). A wrong quiz answer paired with high confidence is flagged in the student's results and is a stronger signal for the instructor than a plain miss — a genuine misconception, not a guess.
- **"N students online" ticker**: shown to both roles — an anonymized live headcount on the student side, a full presence view (with per-question progress) on the instructor side.
- **Class-wide misconception leaderboard**: the instructor dashboard's top-line signal — ranked misconceptions across every topic, not just one column, so "what do I re-teach this week" is a single glance.
- **Remediation impact tracker**: every "Remediate" click records the class average for that topic at that moment; the dashboard then tracks the average since, live, closing the loop on whether the remediation worked.
- **CSV export**: one click turns the current heatmap into a downloadable `.csv` — a gradebook artifact for your report.
- **Sound + flash alert**: an optional audible ding (synthesized, no audio file) plus a full-width flash on every live submission — makes a demo readable from the back of a room without narrating where to look.

## The four signature features

1. **Weak-topic heatmap** — students × topics, color-coded by score, live. Click a cell to drill into exactly which items were missed.
2. **Misconception aggregation** — each topic's column shows the single most common wrong-answer pattern across the class (e.g. "confuses TCP vs UDP (4 students)"), not just a low score.
3. **One-click remediation** — the instructor clicks "Remediate" on a weak topic; the server bundles the most-missed questions in that topic and broadcasts a banner to student dashboards offering targeted practice.
4. **Peer-anonymous benchmarking** — after submitting, a student sees their score next to the anonymized class average for that topic.

## Project structure

```
mastery-pulse/
  server/
    server.js          Express + Socket.IO app, all API routes, grading logic
    auth.js             bcrypt + JWT, role-checking middleware
    db.js                SQLite schema (topics, items, submissions, remediations)
    seed.js              seeds topics, items, demo users
    topics/*.json        quiz + task + qa items per topic, with misconception tags
  public/
    index.html            landing page → pick a panel
    student/               exam-taking UI, results/benchmarking, remediation banner
    instructor/             heatmap dashboard, drill-down, Q&A review queue
    shared/styles.css       shared design tokens
  render.yaml              one-click Render deploy blueprint
  PROMPT.md                 full spec for an AI coding agent
```

## Deploying to Render (free tier)

1. Push this folder to a new GitHub repository.
2. In Render, choose **New → Blueprint** and point it at the repo — `render.yaml` configures the build/start commands and generates a `JWT_SECRET` automatically.
3. Once deployed, share `/student/login.html` with students and `/instructor/login.html` with the instructor.

### Before you actually rely on it live, know these three things

1. **The database resets on every deploy.** Render's free web service has no persistent disk, so `npm run seed && npm run seed:demo` (the build command) runs fresh on every push — any real exam data from a previous session is gone, replaced by demo accounts + realistic seeded activity. That's actually the right behavior for a course demo (a clean, populated starting point every time), but it means this is **not** a place to accumulate real student history across weeks. If you eventually need that, move to a real hosted database (a free Neon or Supabase Postgres instance, not Render's own free Postgres, which expires after 30 days) — that's a real migration, not a config flag, so ask if you get there.
2. **Webcam-alert emails need two environment variables you set yourself.** `render.yaml` declares `RESEND_API_KEY` and `ALERT_TO_EMAIL` as vars Render should ask you for, but their actual values live only in the Render dashboard (Settings → Environment on the service), never in this repo. Without them, the app runs completely normally — the instructor dashboard alert still fires, only the email is silently skipped.
3. **Free tier spins down after 15 minutes idle.** Open the live URL a couple of minutes before you need it so the first request isn't the one that wakes it up.

## Extending this with Antigravity or another AI coding agent

`PROMPT.md` is a complete, self-contained spec — paste it into Antigravity, Claude Code, or any agent connected to your IDE to regenerate this project or brief it before adding a new feature.

## Ideas if you want to go further

- **Misconception-driven lecture notes**: auto-generate a short "what to re-teach" summary per topic from the aggregated misconception tags.
- **Exam versions / retakes**: allow a student to retake a topic exam and show improvement over time instead of only the latest score.
- **Session replay**: store exam submissions on a timeline so you can show, in your final report, how class-wide scores changed after a remediation was sent.
