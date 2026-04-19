const axios = require('axios');
const cheerio = require('cheerio');

const MOODLE = 'https://www.kodcodeacademy.org.il';

const BASE_H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

function parseCookies(headers, cm = {}) {
  (headers['set-cookie'] || []).forEach(c => {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i > 0) cm[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return cm;
}
function cookieStr(cm) { return Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; '); }

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function loginWithPuppeteer(username, password) {
  const cm = {};
  const getRes = await axios.get(`${MOODLE}/login/index.php`, { headers: BASE_H, maxRedirects: 5 });
  parseCookies(getRes.headers, cm);
  const $ = cheerio.load(getRes.data);
  const logintoken = $('input[name="logintoken"]').val() || '';

  const params = new URLSearchParams();
  params.append('username', username); params.append('password', password);
  params.append('logintoken', logintoken); params.append('anchor', '');

  let url = `${MOODLE}/login/index.php`;
  let res = await axios.post(url, params.toString(), {
    headers: { ...BASE_H, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieStr(cm), Referer: url, Origin: MOODLE },
    maxRedirects: 0, validateStatus: s => s < 600,
  });
  for (let i = 0; i < 8 && [301,302,303].includes(res.status); i++) {
    parseCookies(res.headers, cm);
    url = res.headers.location; if (!url.startsWith('http')) url = MOODLE + url;
    res = await axios.get(url, { headers: { ...BASE_H, Cookie: cookieStr(cm) }, maxRedirects: 0, validateStatus: s => s < 600 });
  }
  parseCookies(res.headers, cm);

  const errMsg = cheerio.load(res.data)('.loginerrors, #loginerrormessage, .alert-danger').text().trim();
  if (errMsg) throw new Error(`Login failed: ${errMsg}`);

  const sesskey = res.data.match(/"sesskey":"([^"]+)"/)?.[1];
  if (!sesskey) throw new Error('Login failed: Could not extract session key');

  // Get userid
  let userid = res.data.match(/"userid":(\d+)/)?.[1];
  if (!userid) {
    const prof = await axios.get(`${MOODLE}/user/profile.php`, { headers: { ...BASE_H, Cookie: cookieStr(cm) }, maxRedirects: 5 });
    parseCookies(prof.headers, cm);
    userid = prof.data.match(/"userid":(\d+)/)?.[1] || prof.data.match(/id=(\d+)/)?.[1];
  }

  const $p = cheerio.load(res.data);
  const fullname = $p('.usertext').first().text().trim() || username;
  const cs = cookieStr(cm);
  console.log(`[Login] OK — sesskey:${sesskey.slice(0,8)}... userid:${userid} name:${fullname}`);

  return { cookies: Object.entries(cm).map(([n,v])=>({name:n,value:v})), cookieMap: cm, sesskey, userid: parseInt(userid)||null, fullname };
}

// ─── HTTP CLIENT ──────────────────────────────────────────────────────────────
function makeClient(cookieMap) {
  return axios.create({
    baseURL: MOODLE, timeout: 25000, maxRedirects: 5,
    headers: { ...BASE_H, Cookie: cookieStr(cookieMap) },
  });
}

async function ajax(client, sesskey, methods) {
  const r = await client.post(`/lib/ajax/service.php?sesskey=${sesskey}`, methods, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return r.data;
}

// ─── COURSES ──────────────────────────────────────────────────────────────────
async function fetchCourses(client, sesskey) {
  try {
    const d = await ajax(client, sesskey, [{ index: 0, methodname: 'core_course_get_enrolled_courses_by_timeline_classification', args: { offset: 0, limit: 50, classification: 'all', sort: 'fullname', customfieldname: '', customfieldvalue: '' } }]);
    if (d[0]?.error) return [];
    return (d[0]?.data?.courses || []).map(c => ({
      id: c.id, fullname: c.fullname, shortname: c.shortname,
      progress: Math.round(c.progress || 0), category: c.coursecategory || '',
      url: `${MOODLE}/course/view.php?id=${c.id}`,
    }));
  } catch { return []; }
}

// ─── COURSE CONTENT (sections + activities) ───────────────────────────────────
async function fetchCourseContent(client, courseId) {
  const res = await client.get(`/course/view.php?id=${courseId}`);
  const $ = cheerio.load(res.data);
  const sections = [];

  $('.course-section, [data-for="section"]').each((_, sec) => {
    const sectionName = $(sec).find('.sectionname, h3, .section-title').first().text().replace(/\s+/g,' ').trim() || 'כללי';
    const activities = [];

    $(sec).find('li.activity, .activity').each((_, act) => {
      const cls = $(act).attr('class') || '';
      // Extract module type from class list
      const typeMatch = cls.match(/\bmodtype_(\w+)\b/) || cls.match(/\b(assign|forum|resource|quiz|url|folder|page|attendance|label|choice|workshop|glossary|survey|feedback|chat|wiki|lesson|scorm|book|h5pactivity)\b/);
      const type = typeMatch ? typeMatch[1] : 'unknown';
      if (type === 'label' || type === 'unknown') return;

      const nameEl = $(act).find('.instancename, .activityname a, .aalink').first();
      const name = nameEl.text().replace(/\s+/g,' ').trim().replace(/^(File|Assignment|Forum|Quiz|Resource|URL|Folder|Page|Attendance)\s*/i,'');
      const link = $(act).find('a.aalink, a').first().attr('href') || '';
      const cmidMatch = link.match(/[?&]id=(\d+)/);
      const cmid = cmidMatch ? parseInt(cmidMatch[1]) : null;
      const iconSrc = $(act).find('img.activityicon, img').first().attr('src') || '';

      if (!name || !link) return;
      activities.push({ type, name, link, cmid, iconSrc });
    });

    if (activities.length > 0 || sectionName !== 'כללי') {
      sections.push({ name: sectionName, activities });
    }
  });

  return sections;
}

// ─── RESOURCE / FILE ─────────────────────────────────────────────────────────
async function fetchResource(client, cmid) {
  const res = await client.get(`/mod/resource/view.php?id=${cmid}`);
  const $ = cheerio.load(res.data);

  // Try to find file link
  let fileUrl = $('a[href*="pluginfile"]').first().attr('href')
    || $('object[data*="pluginfile"]').first().attr('data')
    || $('iframe[src*="pluginfile"]').first().attr('src')
    || $('a[href*="/file/"]').first().attr('href');

  // If it redirected directly to the file
  if (!fileUrl && res.request?.res?.responseUrl?.includes('pluginfile')) {
    fileUrl = res.request.res.responseUrl;
  }

  const title = $('h2, h1, .page-header-headings').first().text().trim();
  const description = $('.resourceworkaround, .box.generalbox').first().text().trim();

  return { title, fileUrl, description, type: 'resource' };
}

// ─── PAGE (mod/page) ─────────────────────────────────────────────────────────
async function fetchPage(client, cmid) {
  const res = await client.get(`/mod/page/view.php?id=${cmid}`);
  const $ = cheerio.load(res.data);
  const title = $('h2, .page-header-headings').first().text().trim();
  const content = $('.box.generalbox.center.clearfix, #region-main .box.generalbox, .pagecontent').html() || '';
  return { title, content, type: 'page' };
}

// ─── FORUM ────────────────────────────────────────────────────────────────────
async function fetchForum(client, cmid) {
  const res = await client.get(`/mod/forum/view.php?id=${cmid}`);
  const $ = cheerio.load(res.data);
  const title = $('h2, .page-header-headings').first().text().trim();
  const discussions = [];

  $('table.forumheaderlist tbody tr, .discussion-list .discussion').each((i, row) => {
    const link = $(row).find('a').first().attr('href') || '';
    const subject = $(row).find('a').first().text().trim() || $(row).find('.subject').text().trim();
    const author = $(row).find('.author, td:nth-child(3)').text().trim();
    const replies = $(row).find('.replies, td:nth-child(4)').text().trim();
    const lastpost = $(row).find('.lastpost, td:last-child').text().trim();
    const didMatch = link.match(/[?&]d=(\d+)/);
    if (subject && didMatch) {
      discussions.push({ id: parseInt(didMatch[1]), subject, author, replies: parseInt(replies)||0, lastpost, link });
    }
  });

  return { title, discussions, type: 'forum', cmid };
}

async function fetchDiscussion(client, discussionId) {
  const res = await client.get(`/mod/forum/discuss.php?d=${discussionId}`);
  const $ = cheerio.load(res.data);
  const posts = [];

  $('.forumpost, article.forum-post-container').each((i, post) => {
    const author = $(post).find('.author, .username, [data-region="post-author-name"]').first().text().trim();
    const subject = $(post).find('.subject, h3.subject').first().text().trim();
    const content = $(post).find('.posting, .post-content-container, [data-region="post-body"]').first().text().replace(/\s+/g,' ').trim();
    const time = $(post).find('.time, time').first().text().trim();
    if (content) posts.push({ author, subject, content: content.slice(0, 800), time });
  });

  const title = $('h2, .page-header-headings').first().text().trim();
  return { title, posts, type: 'discussion' };
}

async function postToForum(client, sesskey, discussionId, subject, message) {
  // Get the post form
  const formRes = await client.get(`/mod/forum/post.php?reply=${discussionId}`);
  const $ = cheerio.load(formRes.data);
  const formAction = $('form#mformforum').attr('action') || `${MOODLE}/mod/forum/post.php`;
  const sesskey2 = $('input[name="sesskey"]').val() || sesskey;
  const course = $('input[name="course"]').val();
  const forum = $('input[name="forum"]').val();
  const discussion = $('input[name="discussion"]').val();
  const parent = $('input[name="parent"]').val();

  const params = new URLSearchParams();
  params.append('sesskey', sesskey2);
  params.append('course', course || '');
  params.append('forum', forum || '');
  params.append('discussion', discussion || discussionId);
  params.append('parent', parent || discussionId);
  params.append('subject', subject);
  params.append('message', message);
  params.append('messageformat', '1');
  params.append('mform_isexpanded_id_general', '1');
  params.append('submitbutton', 'Post to forum');

  const postRes = await client.post(formAction, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${MOODLE}/mod/forum/discuss.php?d=${discussionId}` },
    maxRedirects: 5,
  });
  return { success: !postRes.data.includes('error'), message: 'פורסם בהצלחה' };
}

// ─── ASSIGNMENT ───────────────────────────────────────────────────────────────
async function fetchAssignment(client, cmid) {
  const res = await client.get(`/mod/assign/view.php?id=${cmid}`);
  const $ = cheerio.load(res.data);

  const title = $('h2, .page-header-headings').first().text().trim();
  const description = $('.box.generalbox.boxaligncenter .generalbox, #intro, .submissionstatustable + .generalbox').text().replace(/\s+/g,' ').trim();
  const dueDate = $('[data-region="due-date"], .submissionstatustable tr').filter((i,r)=>$(r).text().includes('due')||$(r).text().includes('Due')||$(r).text().includes('מועד')).find('td').last().text().trim();
  const status = $('.submissionstatustable tr').filter((i,r)=>$(r).text().includes('Submission status')||$(r).text().includes('Status')).find('td').last().text().trim();
  const canSubmit = !!$('#id_submitbutton, .singlebutton input[value*="Submit"], button[name="submitbutton"]').length;
  const fileSubmission = !!$('#id_files, .filemanager').length;
  const textSubmission = !!$('#id_onlinetext_editor, .assignsubmission-onlinetext').length;
  const submissionText = $('.submissionstatustable, .box.generalbox.submissionstatustable').text().replace(/\s+/g,' ').trim();

  return { title, description, dueDate, status, canSubmit, fileSubmission, textSubmission, submissionText, type: 'assign', cmid };
}

async function submitAssignment(client, sesskey, cmid, onlineText) {
  // Get submission form
  const formRes = await client.get(`/mod/assign/view.php?id=${cmid}&action=editsubmission`);
  const $ = cheerio.load(formRes.data);
  const sesskey2 = $('input[name="sesskey"]').val() || sesskey;
  const params = new URLSearchParams();
  params.append('sesskey', sesskey2);
  params.append('action', 'savesubmission');
  params.append('id', cmid);
  params.append('onlinetext_editor[text]', onlineText);
  params.append('onlinetext_editor[format]', '1');
  const submitRes = await client.post(`/mod/assign/view.php`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${MOODLE}/mod/assign/view.php?id=${cmid}` },
    maxRedirects: 5,
  });
  const success = !submitRes.data.includes('error') && submitRes.data.includes('assign');
  return { success, message: success ? 'המשימה הוגשה בהצלחה!' : 'שגיאה בהגשת המשימה' };
}

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────
async function fetchAttendance(client, cmid) {
  const res = await client.get(`/mod/attendance/view.php?id=${cmid}`);
  const $ = cheerio.load(res.data);
  const title = $('h2, .page-header-headings').first().text().trim();
  const sessions = [];
  let present = 0, absent = 0, total = 0;

  $('table tr').each((i, row) => {
    const cells = $(row).find('td').map((j, c) => $(c).text().replace(/\s+/g,' ').trim()).get();
    if (cells.length >= 3) {
      const date = cells[0];
      const sessionType = cells[1] || '';
      const status = cells[2] || '';
      const points = cells[3] || '';
      if (date && (status.toLowerCase().includes('present') || status.includes('נוכח') || status === 'P' || status === '✓')) {
        sessions.push({ date, sessionType, status: 'present', statusLabel: 'נוכח', points });
        present++; total++;
      } else if (date && (status.toLowerCase().includes('absent') || status.includes('נעדר') || status === 'A' || status === '✗')) {
        sessions.push({ date, sessionType, status: 'absent', statusLabel: 'נעדר', points });
        absent++; total++;
      } else if (date && cells.length >= 3) {
        sessions.push({ date, sessionType, status: 'unknown', statusLabel: status || '?', points });
        if (status !== '?') total++;
      }
    }
  });

  const pct = total > 0 ? Math.round(present / total * 100) : 0;
  return { title, sessions, summary: { present, absent, total, pct }, type: 'attendance' };
}

// ─── GRADES (per-course) ──────────────────────────────────────────────────────
async function fetchGradesForCourse(client, courseId, courseName) {
  try {
    const res = await client.get(`/grade/report/user/index.php?id=${courseId}`);
    const $ = cheerio.load(res.data);
    const items = [];
    $('table tr').each((_, row) => {
      const cells = $(row).find('th,td');
      if (cells.length < 3) return;
      const name = $(cells[0]).text().replace(/\s+/g,' ').trim();
      const gradeText = $(cells[2]).text().replace(/\s+/g,' ').trim();
      if (!name || name === 'Grade item' || gradeText === '-' || gradeText === '' || gradeText === 'Grade') return;
      const g = parseFloat(gradeText.replace(',','.'));
      if (isNaN(g)) return;
      const isTotal = name.toLowerCase().includes('total') || name.includes('סה"כ');
      items.push({ name: name.replace(/^(Manual item|Aggregation)/i,'').trim() || name, grade: g, isTotal, coursename: courseName, courseid: courseId });
    });
    const total = items.find(it=>it.isTotal);
    const nonTotal = items.filter(it=>!it.isTotal);
    return { courseid: courseId, coursename: courseName, grade: total?.grade ?? null, items: nonTotal };
  } catch { return { courseid: courseId, coursename: courseName, grade: null, items: [] }; }
}

// ─── ASSIGNMENTS LIST ─────────────────────────────────────────────────────────
async function fetchAssignments(client, sesskey) {
  try {
    const now = Math.floor(Date.now()/1000);
    const d = await ajax(client, sesskey, [{ index:0, methodname:'core_calendar_get_action_events_by_timesort', args:{timesortfrom:now-60*86400,timesortto:now+120*86400,limitnum:100} }]);
    if (d[0]?.error) return [];
    return (d[0]?.data?.events||[]).map(e=>({
      id:e.id, name:e.name, courseid:e.course?.id, coursename:e.course?.fullname||'',
      duedate:e.timesort, completed:e.action?.actionable===false,
      overdue:e.timesort<now&&e.action?.actionable!==false,
      daysLeft:Math.ceil((e.timesort-now)/86400), modulename:e.modulename||'assign',
      url:e.url||'', cmid: e.url?.match(/[?&]id=(\d+)/)?.[1]||null,
    }));
  } catch { return []; }
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
async function fetchMessages(client, sesskey, userid) {
  try {
    const d = await ajax(client, sesskey, [{ index:0, methodname:'message_popup_get_popup_notifications', args:{useridto:userid,newestfirst:true,limit:30,offset:0} }]);
    if (d[0]?.error) return [];
    return (d[0]?.data?.notifications||[]).map(n=>({
      id:n.id, subject:n.subject||'הודעה',
      text:(n.fullmessagehtml||n.fullmessage||n.smallmessage||'').replace(/<[^>]+>/g,'').trim(),
      timecreated:n.timecreated, read:!!n.read, sender:n.userfromfullname||'מערכת',
    }));
  } catch { return []; }
}

// ─── MAIN DASHBOARD DATA ──────────────────────────────────────────────────────
async function fetchAllData(session) {
  const { cookieMap, sesskey, userid } = session;
  const client = makeClient(cookieMap);

  const [courses, assignments, messages] = await Promise.all([
    fetchCourses(client, sesskey),
    fetchAssignments(client, sesskey),
    fetchMessages(client, sesskey, userid),
  ]);

  const gradesResults = await Promise.all(courses.map(c => fetchGradesForCourse(client, c.id, c.fullname)));
  const grades = gradesResults;
  const gradeMap = {};
  grades.forEach(g => { gradeMap[g.courseid] = g; });

  const enrichedCourses = courses.map(c => ({
    ...c,
    grade: gradeMap[c.id]?.grade ?? null,
    gradeItems: gradeMap[c.id]?.items || [],
  }));

  const numericGrades = grades.filter(g=>g.grade!==null).map(g=>g.grade);
  const avgGrade = numericGrades.length ? Math.round(numericGrades.reduce((a,b)=>a+b,0)/numericGrades.length) : null;

  return {
    courses: enrichedCourses, grades, assignments, messages,
    stats: {
      totalCourses: courses.length, avgGrade,
      openAssignments: assignments.filter(a=>!a.completed&&!a.overdue).length,
      overdueAssignments: assignments.filter(a=>a.overdue).length,
      completedAssignments: assignments.filter(a=>a.completed).length,
      unreadMessages: messages.filter(m=>!m.read).length,
    },
  };
}

module.exports = {
  loginWithPuppeteer, fetchAllData, makeClient,
  fetchCourseContent, fetchResource, fetchPage,
  fetchForum, fetchDiscussion, postToForum,
  fetchAssignment, submitAssignment,
  fetchAttendance, fetchGradesForCourse,
};
