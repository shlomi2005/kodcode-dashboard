const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const MOODLE_URL = 'https://www.kodcodeacademy.org.il';

function getChromiumPath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  const fs = require('fs');
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined;
}

async function loginWithPuppeteer(username, password) {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  // Step 1: GET login page
  console.log('[Login] Fetching login page...');
  const client = axios.create({ maxRedirects: 0, validateStatus: s => s < 400 });

  const getRes = await axios.get(`${MOODLE_URL}/login/index.php`, {
    headers: HEADERS,
    maxRedirects: 5,
  });

  const $login = cheerio.load(getRes.data);
  const logintoken = $login('input[name="logintoken"]').val() || '';
  console.log(`[Login] logintoken: ${logintoken ? logintoken.slice(0,10)+'...' : 'NOT FOUND'}`);

  // Collect cookies from GET response
  const cookieMap = {};
  (getRes.headers['set-cookie'] || []).forEach(c => {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  console.log(`[Login] Initial cookies: ${JSON.stringify(Object.keys(cookieMap))}`);

  // Step 2: POST login — follow redirects manually to collect all cookies
  const params = new URLSearchParams();
  params.append('username', username);
  params.append('password', password);
  params.append('logintoken', logintoken);
  params.append('anchor', '');

  console.log('[Login] POSTing credentials...');

  let postRes;
  let redirectUrl = `${MOODLE_URL}/login/index.php`;
  let hops = 0;

  // Manual redirect loop to collect cookies at each hop
  const reqHeaders = () => ({
    ...HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': `${MOODLE_URL}/login/index.php`,
    'Origin': MOODLE_URL,
    'Cookie': Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; '),
  });

  postRes = await axios.post(redirectUrl, params.toString(), {
    headers: reqHeaders(),
    maxRedirects: 0,
    validateStatus: s => s < 400,
  });

  // Follow up to 5 redirects manually
  while ((postRes.status === 301 || postRes.status === 302 || postRes.status === 303) && hops < 5) {
    (postRes.headers['set-cookie'] || []).forEach(c => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
    redirectUrl = postRes.headers['location'];
    if (!redirectUrl.startsWith('http')) redirectUrl = MOODLE_URL + redirectUrl;
    console.log(`[Login] Redirect ${hops + 1}: ${redirectUrl}`);
    postRes = await axios.get(redirectUrl, {
      headers: { ...HEADERS, Cookie: Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ') },
      maxRedirects: 0,
      validateStatus: s => s < 400,
    });
    hops++;
  }

  // Collect any final cookies
  (postRes.headers['set-cookie'] || []).forEach(c => {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });

  console.log(`[Login] Final URL: ${redirectUrl}, status: ${postRes.status}`);
  console.log(`[Login] All cookies: ${JSON.stringify(Object.keys(cookieMap))}`);

  const $page = cheerio.load(postRes.data);

  // Check for error message
  const errorMsg = $page('.loginerrors, #loginerrormessage, .alert-danger').text().trim();
  if (errorMsg) throw new Error(`Login failed: ${errorMsg}`);

  // If still on login page with no error, credentials might be wrong
  if (redirectUrl.includes('/login/index.php') && !redirectUrl.includes('loginredirect')) {
    const bodySnippet = $page('body').text().slice(0, 200).replace(/\s+/g,' ');
    console.log('[Login] Still on login page. Body:', bodySnippet);
    throw new Error('Login failed: Still on login page after submit');
  }

  // Extract sesskey
  const html = postRes.data;
  const sesskeyMatch = html.match(/"sesskey":"([^"]+)"/) || html.match(/sesskey=([a-zA-Z0-9]+)/);
  const useridMatch = html.match(/"userid":(\d+)/);
  const sesskey = sesskeyMatch ? sesskeyMatch[1] : null;
  const userid = useridMatch ? parseInt(useridMatch[1]) : null;

  console.log(`[Login] sesskey: ${sesskey ? 'FOUND' : 'NOT FOUND'}, userid: ${userid}`);

  if (!sesskey) {
    // Try fetching dashboard explicitly
    console.log('[Login] sesskey not found, fetching dashboard...');
    const dashRes = await axios.get(`${MOODLE_URL}/my/`, {
      headers: { ...HEADERS, Cookie: Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ') },
      maxRedirects: 5,
    });
    const m1 = dashRes.data.match(/"sesskey":"([^"]+)"/);
    const m2 = dashRes.data.match(/"userid":(\d+)/);
    if (m1) {
      const sesskey2 = m1[1];
      const userid2 = m2 ? parseInt(m2[1]) : null;
      const $d = cheerio.load(dashRes.data);
      const fullname2 = $d('.usertext').first().text().trim() || 'משתמש';
      const cookies2 = Object.entries(cookieMap).map(([name, value]) => ({ name, value, domain: 'www.kodcodeacademy.org.il' }));
      console.log(`[Login] Success via dashboard! User: ${fullname2}`);
      return { cookies: cookies2, sesskey: sesskey2, userid: userid2, fullname: fullname2 };
    }
    throw new Error('Login failed: Could not extract session key');
  }

  const fullname = $page('.usertext').first().text().trim()
    || $page('a[data-key="myprofile"]').text().trim()
    || 'משתמש';

  const cookies = Object.entries(cookieMap).map(([name, value]) => ({ name, value, domain: 'www.kodcodeacademy.org.il' }));
  console.log(`[Login] Success! User: ${fullname}, cookies: ${cookies.length}`);
  return { cookies, sesskey, userid, fullname };
}

function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function buildAxiosClient(cookies) {
  const cookieHeader = cookiesToHeader(cookies);
  return axios.create({
    baseURL: MOODLE_URL,
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    },
    timeout: 30000,
  });
}

async function fetchCourses(client, sesskey) {
  try {
    const response = await client.post('/lib/ajax/service.php', [
      {
        index: 0,
        methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
        args: {
          offset: 0,
          limit: 50,
          classification: 'all',
          sort: 'fullname',
          customfieldname: '',
          customfieldvalue: '',
        },
      },
    ], { params: { sesskey } });

    const data = response.data;
    if (!Array.isArray(data) || !data[0]) return [];
    const result = data[0];
    if (result.error) { console.error('Courses API error:', result.exception); return []; }
    const courses = result.data?.courses || [];
    return courses.map(course => ({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      progress: course.progress || 0,
      category: course.coursecategory || '',
      url: `${MOODLE_URL}/course/view.php?id=${course.id}`,
    }));
  } catch (err) {
    console.error('Error fetching courses:', err.message);
    return [];
  }
}

async function fetchGrades(client) {
  try {
    const response = await client.get('/grade/report/overview/index.php');
    const $ = cheerio.load(response.data);
    const grades = [];
    $('table.generaltable tbody tr, .grade-report-overview table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const courseName = $(cells[0]).text().trim();
        const gradeText = $(cells[cells.length - 1]).text().trim();
        if (courseName && gradeText) {
          const gradeNum = parseFloat(gradeText.replace(',', '.'));
          grades.push({ coursename: courseName, grade: isNaN(gradeNum) ? gradeText : gradeNum, isNumeric: !isNaN(gradeNum) });
        }
      }
    });
    return grades;
  } catch (err) {
    console.error('Error fetching grades:', err.message);
    return [];
  }
}

async function fetchAssignments(client, sesskey) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const response = await client.post('/lib/ajax/service.php', [
      {
        index: 0,
        methodname: 'core_calendar_get_action_events_by_timesort',
        args: { timesortfrom: now - 30 * 86400, timesortto: now + 90 * 86400, limitnum: 50 },
      },
    ], { params: { sesskey } });

    const data = response.data;
    if (!Array.isArray(data) || !data[0]) return [];
    const result = data[0];
    if (result.error) { console.error('Assignments API error:', result.exception); return []; }
    const events = result.data?.events || [];
    return events
      .filter(e => e.modulename === 'assign' || e.eventtype === 'due')
      .map(event => ({
        id: event.id,
        name: event.name,
        coursename: event.course?.fullname || '',
        duedate: event.timesort,
        completed: event.action?.actionable === false,
        url: event.url || '',
        overdue: event.timesort < now,
        daysLeft: Math.ceil((event.timesort - now) / 86400),
      }));
  } catch (err) {
    console.error('Error fetching assignments:', err.message);
    return [];
  }
}

async function fetchMessages(client, sesskey, userid) {
  try {
    const response = await client.post('/lib/ajax/service.php', [
      {
        index: 0,
        methodname: 'message_popup_get_popup_notifications',
        args: { useridto: userid, newestfirst: true, limit: 20, offset: 0 },
      },
    ], { params: { sesskey } });

    const data = response.data;
    if (!Array.isArray(data) || !data[0]) return [];
    const result = data[0];
    if (result.error) { console.error('Messages API error:', result.exception); return []; }
    const notifications = result.data?.notifications || [];
    return notifications.map(n => ({
      id: n.id,
      subject: n.subject || n.smallmessage || 'הודעה',
      text: n.fullmessage || n.smallmessage || '',
      timecreated: n.timecreated,
      read: n.read || false,
      sender: n.userfromfullname || 'מערכת',
    }));
  } catch (err) {
    console.error('Error fetching messages:', err.message);
    return [];
  }
}

async function fetchAllData(session) {
  const { cookies, sesskey, userid } = session;
  const client = buildAxiosClient(cookies);
  const [courses, grades, assignments, messages] = await Promise.all([
    fetchCourses(client, sesskey),
    fetchGrades(client),
    fetchAssignments(client, sesskey),
    fetchMessages(client, sesskey, userid),
  ]);
  return { courses, grades, assignments, messages };
}

module.exports = { loginWithPuppeteer, fetchAllData };
