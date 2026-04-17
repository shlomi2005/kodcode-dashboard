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
  const { wrapper: CookieJar, jar } = (() => {
    const tough = require('tough-cookie');
    const j = new tough.CookieJar();
    return { wrapper: tough.CookieJar, jar: j };
  })();

  const { wrapper } = require('axios-cookiejar-support');
  const axiosWithCookies = wrapper(axios.create({
    jar: CookieJar ? new (require('tough-cookie').CookieJar)() : undefined,
    withCredentials: true,
  }));

  // Step 1: GET login page to grab logintoken + cookies
  console.log('[Login] Fetching login page...');
  const loginPageRes = await axiosWithCookies.get(`${MOODLE_URL}/login/index.php`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    },
    maxRedirects: 5,
  });

  const $login = cheerio.load(loginPageRes.data);
  const logintoken = $login('input[name="logintoken"]').val();
  console.log(`[Login] Got logintoken: ${logintoken ? logintoken.slice(0,8) + '...' : 'NOT FOUND'}`);

  // Extract session cookies from response
  const setCookieHeaders = loginPageRes.headers['set-cookie'] || [];
  const cookieStr = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
  console.log(`[Login] Initial cookies: ${cookieStr.slice(0, 80)}`);

  // Step 2: POST login form
  const qs = require('querystring');
  const formData = qs.stringify({
    username,
    password,
    logintoken: logintoken || '',
    anchor: '',
  });

  console.log('[Login] Submitting login form...');
  const loginRes = await axiosWithCookies.post(`${MOODLE_URL}/login/index.php`, formData, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${MOODLE_URL}/login/index.php`,
      'Origin': MOODLE_URL,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      'Cookie': cookieStr,
    },
    maxRedirects: 5,
  });

  const finalUrl = loginRes.request?.res?.responseUrl || loginRes.config?.url || '';
  console.log(`[Login] Final URL after login: ${finalUrl}`);

  const $dashboard = cheerio.load(loginRes.data);

  // Check for error
  const errorText = $dashboard('.loginerrors, #loginerrormessage, .alert-danger').text().trim();
  if (errorText || finalUrl.includes('/login/')) {
    throw new Error(`Login failed: ${errorText || 'Still on login page'}`);
  }

  // Extract sesskey from page JS
  const pageHtml = loginRes.data;
  const sesskeyMatch = pageHtml.match(/"sesskey"\s*:\s*"([^"]+)"/);
  const useridMatch = pageHtml.match(/"userid"\s*:\s*(\d+)/);
  const sesskey = sesskeyMatch ? sesskeyMatch[1] : null;
  const userid = useridMatch ? parseInt(useridMatch[1]) : null;

  console.log(`[Login] sesskey: ${sesskey ? sesskey.slice(0,8)+'...' : 'NOT FOUND'}, userid: ${userid}`);

  if (!sesskey) {
    throw new Error('Login failed: Could not extract session key. Check credentials.');
  }

  // Extract fullname
  const fullname = $dashboard('.usertext, .usermenu .usertext, [data-region="user-menu"] .usertext').first().text().trim()
    || $dashboard('a[data-key="myprofile"]').text().trim()
    || 'משתמש';

  // Collect all cookies from both responses
  const allSetCookies = [
    ...(loginPageRes.headers['set-cookie'] || []),
    ...(loginRes.headers['set-cookie'] || []),
  ];

  const cookieMap = {};
  allSetCookies.forEach(c => {
    const [pair] = c.split(';');
    const [name, ...rest] = pair.split('=');
    cookieMap[name.trim()] = rest.join('=').trim();
  });

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
