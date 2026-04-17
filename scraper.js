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
  let browser;
  const executablePath = getChromiumPath();
  console.log(`[Puppeteer] Using Chromium at: ${executablePath || 'bundled'}`);

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    });

    console.log('[Puppeteer] Browser launched');
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7' });

    console.log('[Puppeteer] Navigating to login page...');
    await page.goto(`${MOODLE_URL}/login/index.php`, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log('[Puppeteer] Login page loaded, filling credentials...');
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.type('#username', username);
    await page.type('#password', password);

    // Simulate human-like behavior
    await page.mouse.move(100, 200);
    await new Promise(r => setTimeout(r, 500));

    console.log('[Puppeteer] Submitting login form...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click('#loginbtn'),
    ]);

    console.log('[Puppeteer] Navigation complete, checking login result...');

    // Log current URL to see where we ended up
    const currentUrl = page.url();
    console.log('[Puppeteer] Current URL after login:', currentUrl);

    // Check for login error
    const errorEl = await page.$('.loginerrors, #loginerrormessage, .alert-danger, .alert');
    if (errorEl) {
      const errorText = await page.evaluate(el => el.textContent, errorEl);
      console.log('[Puppeteer] Error element text:', errorText.trim());
      // If still on login page, credentials are wrong
      if (currentUrl.includes('/login/')) {
        throw new Error(`Login failed: ${errorText.trim()}`);
      }
    }

    // Extract sesskey and user info
    const pageData = await page.evaluate(() => {
      const cfg = window.M && window.M.cfg;
      const url = window.location.href;
      return {
        sesskey: cfg ? cfg.sesskey : null,
        userid: cfg ? cfg.userid : null,
        url,
      };
    });

    console.log(`[Puppeteer] Page after login: ${pageData.url}`);
    console.log(`[Puppeteer] sesskey found: ${!!pageData.sesskey}, userid: ${pageData.userid}`);

    if (!pageData.sesskey) {
      // Try to get page HTML for debugging
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('[Puppeteer] Page body snippet:', bodyText);
      throw new Error('Login failed: Could not extract session key');
    }

    // Extract fullname from page
    const fullname = await page.evaluate(() => {
      const selectors = [
        '.usertext',
        '.usermenu .userbutton .usertext',
        '[data-region="user-menu"] .usertext',
        '.username',
        '[data-key="myprofile"] .menu-action-text',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return 'משתמש';
    });

    // Get cookies from browser
    const cookies = await page.cookies();
    console.log(`[Puppeteer] Login success! User: ${fullname}, cookies: ${cookies.length}`);

    await browser.close();
    browser = null;

    return {
      cookies,
      sesskey: pageData.sesskey,
      userid: pageData.userid,
      fullname,
    };
  } catch (err) {
    console.error('[Puppeteer] Error:', err.message);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    throw err;
  }
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
