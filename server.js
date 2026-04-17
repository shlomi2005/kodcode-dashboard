const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { loginWithPuppeteer, fetchAllData } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory session store: sessionId → { cookies, sesskey, userid, fullname, expires }
const sessions = new Map();
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

// Clean up expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires < now) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, timestamp: new Date().toISOString() });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'שדות חסרים: שם משתמש וסיסמה נדרשים' });
  }

  try {
    console.log(`[Login] Attempting login for user: ${username}`);
    const loginData = await loginWithPuppeteer(username, password);

    const sessionId = uuidv4();
    sessions.set(sessionId, {
      cookies: loginData.cookies,
      sesskey: loginData.sesskey,
      userid: loginData.userid,
      fullname: loginData.fullname,
      expires: Date.now() + SESSION_TTL,
    });

    console.log(`[Login] Success for user: ${loginData.fullname}, sessionId: ${sessionId}`);
    res.json({
      sessionId,
      fullname: loginData.fullname,
      userid: loginData.userid,
    });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    if (err.message.includes('Login failed')) {
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }
    res.status(500).json({ error: 'שגיאת שרת. נסה שוב מאוחר יותר.' });
  }
});

// GET /api/data
app.get('/api/data', async (req, res) => {
  const { sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).json({ error: 'חסר sessionId' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'SESSION_EXPIRED' });
  }

  if (session.expires < Date.now()) {
    sessions.delete(sessionId);
    return res.status(401).json({ error: 'SESSION_EXPIRED' });
  }

  // Refresh TTL on access
  session.expires = Date.now() + SESSION_TTL;

  try {
    console.log(`[Data] Fetching data for session: ${sessionId}`);
    const data = await fetchAllData(session);
    res.json(data);
  } catch (err) {
    console.error('[Data] Error:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת הנתונים' });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

// Catch-all: serve index.html for React routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KodCode Dashboard server running on port ${PORT}`);
});
