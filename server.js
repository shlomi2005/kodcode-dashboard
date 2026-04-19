const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loginWithPuppeteer, fetchAllData } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Session store: sessionId → { cookieMap, sesskey, userid, fullname, expires, cache }
const sessions = new Map();
const SESSION_TTL = 60 * 60 * 1000;     // 1 hour
const CACHE_TTL  = 5  * 60 * 1000;      // 5 minutes data cache

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expires < now) sessions.delete(id);
  }
}, 10 * 60 * 1000);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, ts: new Date().toISOString() });
});

// ── Login ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'שדות חסרים' });

  try {
    console.log(`[Login] Attempting login for user: ${username}`);
    const loginData = await loginWithPuppeteer(username, password);

    const sessionId = uuidv4();
    sessions.set(sessionId, {
      cookieMap: loginData.cookieMap,
      cookies:   loginData.cookies,
      sesskey:   loginData.sesskey,
      userid:    loginData.userid,
      fullname:  loginData.fullname,
      expires:   Date.now() + SESSION_TTL,
      cache:     null,
      cacheAt:   0,
    });

    console.log(`[Login] Success: ${loginData.fullname}`);
    res.json({ sessionId, fullname: loginData.fullname, userid: loginData.userid });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    if (err.message.includes('Login failed')) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    res.status(500).json({ error: 'שגיאת שרת. נסה שוב.' });
  }
});

// ── Data ─────────────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  const { sessionId, refresh } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'חסר sessionId' });

  const session = sessions.get(sessionId);
  if (!session || session.expires < Date.now()) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: 'SESSION_EXPIRED' });
  }

  session.expires = Date.now() + SESSION_TTL;

  // Return cached data if fresh
  if (!refresh && session.cache && Date.now() - session.cacheAt < CACHE_TTL) {
    return res.json(session.cache);
  }

  try {
    console.log(`[Data] Fetching for session ${sessionId.slice(0, 8)}...`);
    const data = await fetchAllData(session);
    session.cache  = data;
    session.cacheAt = Date.now();
    res.json(data);
  } catch (err) {
    console.error('[Data] Error:', err.message);
    if (session.cache) return res.json({ ...session.cache, stale: true });
    res.status(500).json({ error: 'שגיאה בשליפת הנתונים' });
  }
});

// ── Logout ───────────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) sessions.delete(sessionId);
  res.json({ success: true });
});

// ── Catch-all → SPA ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KodCode Dashboard running on port ${PORT}`);
});
