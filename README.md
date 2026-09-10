# Mastery Pulse

A real-time exam platform for a graduate IT/CS course, covering **Cybersecurity, Web Technology, Networking, Cloud Computing, and Full Stack Development**. Students take a mixed-format exam per topic — quiz, task, and short-answer Q&A — and the moment they submit, the instructor's dashboard shows a live weak-topic heatmap: exactly which topics that student, and the class as a whole, are struggling with.

Built for the course topic **"Designing a Client-Server Architecture for Web Applications."**

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
npm run seed     # creates the SQLite DB, topics/items, and demo accounts
npm start          # starts the server on http://localhost:3000
```

## Demo credentials

| Role | Username | Password |
|---|---|---|
| Instructor | `prof.demo` | `MasterClass#2026` |
| Student | `student1` … `student10` | `Pulse#Student1` … `Pulse#Student10` |

(Same pattern for all ten: `studentN` / `Pulse#StudentN`.)

Open the instructor dashboard in one tab and a student login in another (or incognito) to watch the heatmap update live as exams are submitted.

## Proving it's a live app, not a form

Everything below fires over the same Socket.IO connection used for the heatmap — there's no polling, no refresh button.

- **Live-while-typing progress**: the instant a student opens an exam, the instructor dashboard shows a presence chip — `Aiden Cross — Networking (3/8)` — that advances with every question answered, *before* the student submits.
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
4. Free-tier gotchas: the service spins down after 15 minutes idle (open it a couple of minutes before class), and if you move from SQLite to Postgres for longer persistence, use a free Neon or Supabase instance rather than Render's own free Postgres, which expires after 30 days.

## Extending this with Antigravity or another AI coding agent

`PROMPT.md` is a complete, self-contained spec — paste it into Antigravity, Claude Code, or any agent connected to your IDE to regenerate this project or brief it before adding a new feature.

## Ideas if you want to go further

- **Misconception-driven lecture notes**: auto-generate a short "what to re-teach" summary per topic from the aggregated misconception tags.
- **Exam versions / retakes**: allow a student to retake a topic exam and show improvement over time instead of only the latest score.
- **Session replay**: store exam submissions on a timeline so you can show, in your final report, how class-wide scores changed after a remediation was sent.
