const axios = require('axios');
const cheerio = require('cheerio');

const MOODLE_URL = 'https://www.kodcodeacademy.org.il';

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive',
};

function parseCookies(headers, existing = {}) {
  (headers['set-cookie'] || []).forEach(c => {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) existing[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  return existing;
}

function cookieStr(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function loginWithPuppeteer(username, password) {
  const cm = {};

  // 1. GET login page → grab logintoken + initial cookies
  const getRes = await axios.get(`${MOODLE_URL}/login/index.php`, {
    headers: BASE_HEADERS,
    maxRedirects: 5,
  });
  parseCookies(getRes.headers, cm);

  const $login = cheerio.load(getRes.data);
  const logintoken = $login('input[name="logintoken"]').val() || '';
  console.log(`[Login] logintoken: ${logintoken ? 'OK' : 'MISSING'}, cookies: ${Object.keys(cm)}`);

  // 2. POST credentials
  const params = new URLSearchParams();
  params.append('username', username);
  params.append('password', password);
  params.append('logintoken', logintoken);
  params.append('anchor', '');

  let url = `${MOODLE_URL}/login/index.php`;
  let res = await axios.post(url, params.toString(), {
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieStr(cm),
      'Referer': url,
      'Origin': MOODLE_URL,
    },
    maxRedirects: 0,
    validateStatus: s => s < 600,
  });

  // 3. Follow all redirects manually (to collect every Set-Cookie)
  for (let i = 0; i < 8 && (res.status === 301 || res.status === 302 || res.status === 303); i++) {
    parseCookies(res.headers, cm);
    url = res.headers.location;
    if (!url.startsWith('http')) url = MOODLE_URL + url;
    console.log(`[Login] Redirect ${i + 1}: ${url}`);
    res = await axios.get(url, {
      headers: { ...BASE_HEADERS, Cookie: cookieStr(cm) },
      maxRedirects: 0,
      validateStatus: s => s < 600,
    });
  }
  parseCookies(res.headers, cm);

  // 4. Check for error
  const $page = cheerio.load(res.data);
  const errMsg = $page('.loginerrors, #loginerrormessage, .alert-danger').text().trim();
  if (errMsg) throw new Error(`Login failed: ${errMsg}`);
  if (url.includes('/login/index.php') && !url.includes('testsession')) {
    throw new Error('Login failed: Redirected back to login page');
  }

  // 5. Extract sesskey + userid
  const sesskey = res.data.match(/"sesskey":"([^"]+)"/)?.[1] || null;
  let userid = res.data.match(/"userid":(\d+)/)?.[1];

  // Fallback: get userid from profile page
  if (!userid) {
    const prof = await axios.get(`${MOODLE_URL}/user/profile.php`, {
      headers: { ...BASE_HEADERS, Cookie: cookieStr(cm) },
      maxRedirects: 5,
    });
    parseCookies(prof.headers, cm);
    userid = prof.data.match(/"userid":(\d+)/)?.[1]
      || prof.data.match(/user\/profile\.php\?id=(\d+)/)?.[1]
      || prof.data.match(/id=(\d+)/)?.[1];
  }
  userid = parseInt(userid) || null;

  if (!sesskey) throw new Error('Login failed: Could not extract session key');

  // 6. Get fullname
  const fullname = $page('.usertext').first().text().trim()
    || $page('[data-key="myprofile"]').first().text().trim()
    || username;

  const cookies = Object.entries(cm).map(([name, value]) => ({ name, value, domain: 'www.kodcodeacademy.org.il' }));
  console.log(`[Login] Success! sesskey OK, userid: ${userid}, name: ${fullname}`);

  return { cookies, cookieMap: cm, sesskey, userid, fullname };
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

function makeClient(cookieMap) {
  const cs = cookieStr(cookieMap);
  return axios.create({
    baseURL: MOODLE_URL,
    headers: {
      ...BASE_HEADERS,
      Cookie: cs,
      Accept: 'application/json, text/html, */*',
    },
    timeout: 20000,
    maxRedirects: 5,
  });
}

async function ajaxCall(client, sesskey, methods) {
  const res = await client.post(`/lib/ajax/service.php?sesskey=${sesskey}`, methods, {
    headers: { 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ─── COURSES ─────────────────────────────────────────────────────────────────

async function fetchCourses(client, sesskey) {
  try {
    const data = await ajaxCall(client, sesskey, [{
      index: 0,
      methodname: 'core_course_get_enrolled_courses_by_timeline_classification',
      args: { offset: 0, limit: 50, classification: 'all', sort: 'fullname', customfieldname: '', customfieldvalue: '' },
    }]);
    if (data[0]?.error) { console.error('Courses error:', data[0].exception?.message); return []; }
    return (data[0]?.data?.courses || []).map(c => ({
      id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      progress: Math.round(c.progress || 0),
      category: c.coursecategory || '',
      imageurl: c.courseimage || null,
      url: `${MOODLE_URL}/course/view.php?id=${c.id}`,
      startdate: c.startdate,
      enddate: c.enddate,
    }));
  } catch (e) {
    console.error('fetchCourses error:', e.message);
    return [];
  }
}

// ─── GRADES (per-course user report) ─────────────────────────────────────────

async function fetchGradesForCourse(client, courseId, courseName) {
  try {
    const res = await client.get(`/grade/report/user/index.php?id=${courseId}`);
    const $ = cheerio.load(res.data);
    const items = [];

    $('table tr').each((i, row) => {
      const cells = $(row).find('th, td');
      if (cells.length < 3) return;

      const name = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const gradeText = $(cells[2]).text().replace(/\s+/g, ' ').trim();
      const rangeText = $(cells[3]) ? $(cells[3]).text().trim() : '';
      const pctText = $(cells[4]) ? $(cells[4]).text().trim() : '';

      // Skip headers and empty rows
      if (!name || name === 'Grade item' || name === 'Course total header') return;
      if (gradeText === '-' || gradeText === '' || gradeText === 'Grade') return;

      const gradeNum = parseFloat(gradeText.replace(',', '.'));
      if (isNaN(gradeNum)) return;

      // Detect if it's a total/aggregation row
      const isTotal = name.toLowerCase().includes('total') || name.includes('סה"כ') || $(cells[0]).find('.level1').length > 0;

      items.push({
        name: name.replace(/^(Manual item|Aggregation)/i, '').trim() || name,
        grade: gradeNum,
        range: rangeText,
        percentage: parseFloat(pctText) || null,
        isTotal,
        courseid: courseId,
        coursename: courseName,
      });
    });

    return items;
  } catch (e) {
    console.error(`fetchGrades course ${courseId} error:`, e.message);
    return [];
  }
}

async function fetchAllGrades(client, courses) {
  const results = await Promise.all(
    courses.map(c => fetchGradesForCourse(client, c.id, c.fullname))
  );

  // Build per-course summary + all items
  const courseSummaries = [];
  const allItems = [];

  courses.forEach((course, i) => {
    const items = results[i];
    allItems.push(...items);

    const total = items.find(it => it.isTotal);
    const nonTotal = items.filter(it => !it.isTotal);
    const avg = nonTotal.length
      ? Math.round(nonTotal.reduce((s, it) => s + it.grade, 0) / nonTotal.length)
      : (total ? total.grade : null);

    courseSummaries.push({
      courseid: course.id,
      coursename: course.fullname,
      grade: total ? total.grade : avg,
      items: nonTotal,
    });
  });

  return { summaries: courseSummaries, items: allItems };
}

// ─── ASSIGNMENTS & EVENTS ────────────────────────────────────────────────────

async function fetchAssignments(client, sesskey) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const data = await ajaxCall(client, sesskey, [{
      index: 0,
      methodname: 'core_calendar_get_action_events_by_timesort',
      args: { timesortfrom: now - 60 * 86400, timesortto: now + 120 * 86400, limitnum: 100 },
    }]);
    if (data[0]?.error) { console.error('Assignments error:', data[0].exception?.message); return []; }

    return (data[0]?.data?.events || []).map(e => ({
      id: e.id,
      name: e.name,
      courseid: e.course?.id,
      coursename: e.course?.fullname || '',
      duedate: e.timesort,
      completed: e.action?.actionable === false,
      overdue: e.timesort < now && e.action?.actionable !== false,
      daysLeft: Math.ceil((e.timesort - now) / 86400),
      modulename: e.modulename || 'assign',
      url: e.url || '',
      description: e.description || '',
    }));
  } catch (e) {
    console.error('fetchAssignments error:', e.message);
    return [];
  }
}

// ─── MESSAGES ────────────────────────────────────────────────────────────────

async function fetchMessages(client, sesskey, userid) {
  try {
    const data = await ajaxCall(client, sesskey, [{
      index: 0,
      methodname: 'message_popup_get_popup_notifications',
      args: { useridto: userid, newestfirst: true, limit: 30, offset: 0 },
    }]);
    if (data[0]?.error) { console.error('Messages error:', data[0].exception?.message); return []; }
    return (data[0]?.data?.notifications || []).map(n => ({
      id: n.id,
      subject: n.subject || n.smallmessage || 'הודעה',
      text: (n.fullmessagehtml || n.fullmessage || n.smallmessage || '').replace(/<[^>]+>/g, '').trim(),
      timecreated: n.timecreated,
      read: !!n.read,
      sender: n.userfromfullname || 'מערכת',
    }));
  } catch (e) {
    console.error('fetchMessages error:', e.message);
    return [];
  }
}

// ─── RECENT ACTIVITY ─────────────────────────────────────────────────────────

async function fetchRecentActivity(client) {
  try {
    const res = await client.get('/report/recentactivity/index.php');
    const $ = cheerio.load(res.data);
    const activities = [];
    $('.activityhead, .activity').each((i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text) activities.push(text.slice(0, 120));
    });
    return activities.slice(0, 10);
  } catch {
    return [];
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function fetchAllData(session) {
  const { cookieMap, sesskey, userid } = session;
  const client = makeClient(cookieMap);

  const [courses, assignments, messages] = await Promise.all([
    fetchCourses(client, sesskey),
    fetchAssignments(client, sesskey),
    fetchMessages(client, sesskey, userid),
  ]);

  const grades = await fetchAllGrades(client, courses);

  // Attach grade info to courses
  const enrichedCourses = courses.map(c => {
    const summary = grades.summaries.find(s => s.courseid === c.id);
    return { ...c, grade: summary?.grade ?? null, gradeItems: summary?.items || [] };
  });

  // Compute stats
  const numericGrades = grades.summaries.filter(s => s.grade !== null).map(s => s.grade);
  const avgGrade = numericGrades.length
    ? Math.round(numericGrades.reduce((a, b) => a + b, 0) / numericGrades.length)
    : null;

  return {
    courses: enrichedCourses,
    grades: grades.summaries,
    gradeItems: grades.items,
    assignments,
    messages,
    stats: {
      totalCourses: courses.length,
      avgGrade,
      openAssignments: assignments.filter(a => !a.completed && !a.overdue).length,
      overdueAssignments: assignments.filter(a => a.overdue).length,
      completedAssignments: assignments.filter(a => a.completed).length,
      unreadMessages: messages.filter(m => !m.read).length,
    },
  };
}

module.exports = { loginWithPuppeteer, fetchAllData };
