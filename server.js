const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  loginWithPuppeteer, fetchAllData, makeClient,
  fetchCourseContent, fetchResource, fetchPage,
  fetchForum, fetchDiscussion, postToForum,
  fetchAssignment, submitAssignment,
  fetchAttendance,
} = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;
const CACHE_TTL   = 5 * 60 * 1000;

setInterval(() => { const now=Date.now(); for(const[id,s]of sessions) if(s.expires<now) sessions.delete(id); }, 10*60*1000);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── helpers ───────────────────────────────────────────────────────────────────
function getSession(req, res) {
  const sid = req.query.sessionId || req.body?.sessionId;
  if (!sid) { res.status(400).json({ error: 'חסר sessionId' }); return null; }
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) { sessions.delete(sid); res.status(401).json({ error: 'SESSION_EXPIRED' }); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return s;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status:'ok', sessions:sessions.size }));

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'שדות חסרים' });
  try {
    console.log(`[Login] ${username}`);
    const d = await loginWithPuppeteer(username, password);
    const sessionId = uuidv4();
    sessions.set(sessionId, {
      cookieMap: d.cookieMap, sesskey: d.sesskey,
      userid: d.userid, fullname: d.fullname,
      expires: Date.now() + SESSION_TTL, cache: null, cacheAt: 0,
    });
    res.json({ sessionId, fullname: d.fullname, userid: d.userid });
  } catch (e) {
    console.error('[Login] Error:', e.message);
    if (e.message.includes('Login failed')) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ── Dashboard data ────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  if (!req.query.refresh && s.cache && Date.now()-s.cacheAt < CACHE_TTL) return res.json(s.cache);
  try {
    const data = await fetchAllData(s);
    s.cache = data; s.cacheAt = Date.now();
    res.json(data);
  } catch (e) {
    console.error('[Data]', e.message);
    if (s.cache) return res.json({ ...s.cache, stale: true });
    res.status(500).json({ error: 'שגיאה בשליפת הנתונים' });
  }
});

// ── Course content (sections + activities) ────────────────────────────────────
app.get('/api/course/:id/content', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const client = makeClient(s.cookieMap);
    const content = await fetchCourseContent(client, req.params.id);
    res.json(content);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Activity viewer ───────────────────────────────────────────────────────────
app.get('/api/activity/:type/:cmid', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const { type, cmid } = req.params;
  try {
    const client = makeClient(s.cookieMap);
    let data;
    switch (type) {
      case 'resource': data = await fetchResource(client, cmid); break;
      case 'page':     data = await fetchPage(client, cmid); break;
      case 'forum':    data = await fetchForum(client, cmid); break;
      case 'assign':   data = await fetchAssignment(client, cmid); break;
      case 'attendance': data = await fetchAttendance(client, cmid); break;
      default: data = { type, cmid, message: 'סוג פעילות לא נתמך עדיין' };
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Forum discussion ──────────────────────────────────────────────────────────
app.get('/api/forum/discussion/:id', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  try {
    const client = makeClient(s.cookieMap);
    res.json(await fetchDiscussion(client, req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Post to forum ─────────────────────────────────────────────────────────────
app.post('/api/forum/discussion/:id/post', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const { subject, message } = req.body;
  try {
    const client = makeClient(s.cookieMap);
    res.json(await postToForum(client, s.sesskey, req.params.id, subject, message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Submit assignment ─────────────────────────────────────────────────────────
app.post('/api/assign/:cmid/submit', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const { onlineText } = req.body;
  try {
    const client = makeClient(s.cookieMap);
    res.json(await submitAssignment(client, s.sesskey, req.params.cmid, onlineText));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Proxy file download ───────────────────────────────────────────────────────
app.get('/api/proxy-file', async (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const { url } = req.query;
  if (!url || !url.includes('kodcodeacademy.org.il')) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const axios = require('axios');
    const fileRes = await axios.get(url, {
      headers: { Cookie: Object.entries(s.cookieMap).map(([k,v])=>`${k}=${v}`).join('; '), 'User-Agent': 'Mozilla/5.0' },
      responseType: 'stream', maxRedirects: 5,
    });
    res.set('Content-Type', fileRes.headers['content-type'] || 'application/octet-stream');
    res.set('Content-Disposition', fileRes.headers['content-disposition'] || 'attachment');
    fileRes.data.pipe(res);
  } catch (e) { res.status(500).json({ error: 'שגיאה בהורדת הקובץ' }); }
});

// ── Logout ────────────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const { sessionId } = req.body; if (sessionId) sessions.delete(sessionId);
  res.json({ success: true });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`KodCode running on ${PORT}`));
