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

// Debug login - returns raw page response to diagnose issues
app.post('/api/debug-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const axios = require('axios');
  const cheerio = require('cheerio');
  const MOODLE_URL = 'https://www.kodcodeacademy.org.il';
  try {
    const getRes = await axios.get(`${MOODLE_URL}/login/index.php`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      maxRedirects: 5,
    });
    const $ = cheerio.load(getRes.data);
    const logintoken = $('input[name="logintoken"]').val() || '';
    const cookieMap = {};
    (getRes.headers['set-cookie'] || []).forEach(c => {
      const [p] = c.split(';'); const i = p.indexOf('=');
      if (i > 0) cookieMap[p.slice(0,i).trim()] = p.slice(i+1).trim();
    });
    const cookieStr = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');
    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);
    params.append('logintoken', logintoken);
    params.append('anchor', '');
    const postRes = await axios.post(`${MOODLE_URL}/login/index.php`, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${MOODLE_URL}/login/index.php`,
        'Origin': MOODLE_URL,
      },
      maxRedirects: 0,
      validateStatus: s => s < 600,
    });
    const location = postRes.headers.location || 'no redirect';
    const $2 = cheerio.load(postRes.data || '');
    const errorText = $2('.loginerrors, .alert-danger, .alert').text().trim();
    res.json({
      postStatus: postRes.status,
      location,
      errorOnPage: errorText || 'none',
      usernameReceived: username,
      passwordLength: password.length,
      passwordFirstChar: password[0],
      passwordLastChar: password[password.length - 1],
      logintoken: logintoken.slice(0,10) + '...',
      cookiesSent: Object.keys(cookieMap),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
