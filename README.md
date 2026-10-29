# KodCode Dashboard

<div dir="rtl">

**דשבורד מודרני ולא-רשמי לאתר הלימודים (Moodle) של KodCode Academy.**
כל מה שסטודנט צריך במסך אחד: קורסים, ציונים לפי קורס, מטלות, פורומים, נוכחות וקבצים — בעיצוב כהה, נוח בטלפון.

</div>

## What it does

- **Courses & grades** — every course with its full grade breakdown.
- **Activities** — open lessons, assignments and forum discussions without the slow Moodle UI; submit assignments and reply in forums.
- **Attendance & files** — attendance view and a file proxy for course materials.
- **Mobile first** — bottom navigation and a drawer sidebar on small screens.

## How it works

The student logs in with their own KodCode credentials. The server logs in to Moodle on their behalf, keeps the Moodle session **in memory only** (expires after 2 hours of inactivity) and reads the pages it needs. Passwords are not stored.

| Part | Tech |
|------|------|
| Server | Node.js 18, Express (`server.js`) |
| Moodle client | axios + cookie jar, Puppeteer fallback for login (`scraper.js`) |
| UI | Single-page app in `public/index.html` |
| Deploy | Railway (Nixpacks, health check on `/health`) |

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Note

This is a personal, unofficial project. It is not affiliated with KodCode Academy.
