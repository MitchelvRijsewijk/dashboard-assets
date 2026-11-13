// =====================================================
// USERS — login overview per user (da-users.js)
// Answers one question for IT and the consultant: who actually uses SuperOffice?
// Data: UserLoginFetch (last login per user that can log in) joined with the
// per-user activity counts from MomentumFetch, which load in the background.
// Loaded after da-export.js; uses the shared helpers from da-helpers.js and
// da-entity-logic.js (hcKpi, hcSecLabel, hcInsight, ovCard, fillBar, fmtNum).
// =====================================================

// Day thresholds. Active = logged in within USERS_ACTIVE_DAYS, Lapsing = up to
// USERS_DORMANT_DAYS, Dormant = longer ago, Never = no login recorded.
var USERS_ACTIVE_DAYS = 30;
var USERS_DORMANT_DAYS = 90;
// An account younger than this that never logged in is "new", not neglected.
var USERS_NEW_ACCOUNT_DAYS = 30;

// The endpoint is derived from an existing url, like funnelUrl in da-helpers.js,
// so the host only needs the nav entry and the script tag.
var usersUrl = (typeof momentumUrl === 'string' && momentumUrl) ? momentumUrl.replace('MomentumFetch', 'UserLoginFetch') : '';

var usersData = null;          // { users: [...], totalUsers, generatedAt }
var usersActivity = null;      // map id -> { activities, documents, total }
var usersActivityState = 'idle';  // idle | loading | done | failed
var usersActivityLabel = '';
var usersFilter = 'all';
var usersSearch = '';
var usersSort = { col: 'days', asc: false };

var US_STATUS = {
  active:  { label: 'Active',          bg: 'var(--lvl-power-bg)',   fg: 'var(--lvl-power-ink)' },
  lapsing: { label: 'Lapsing',         bg: 'var(--lvl-low-bg)',     fg: 'var(--lvl-low-ink)' },
  dormant: { label: 'Dormant',         bg: 'var(--lvl-dormant-bg)', fg: 'var(--lvl-dormant-ink)' },
  never:   { label: 'Never logged in', bg: 'var(--chip-fill)',      fg: 'var(--chip-ink)' }
};

function usEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Accepts "YYYY-MM-DD[ HH:MM[:SS]]" and "DD.MM.YYYY[ HH:MM]". Anything empty,
// unparseable or before 1990 counts as no date (an unset DateTime column).
function usParseDate(s) {
  if (!s) return null;
  s = String(s).replace(/^\[DT?:/, '').replace(/\]$/, '');
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  var d = null;
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  else {
    m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s);
    if (m) d = new Date(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  if (!d || isNaN(d.getTime()) || d.getFullYear() < 1990) return null;
  return d;
}

function usIsoDay(d) {
  if (!d) return '';
  var mo = d.getMonth() + 1, dy = d.getDate();
  return d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo + '-' + (dy < 10 ? '0' : '') + dy;
}

function usDaysSince(d, now) {
  if (!d) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000));
}

function usStatusFor(days) {
  if (days === null) return 'never';
  if (days <= USERS_ACTIVE_DAYS) return 'active';
  if (days <= USERS_DORMANT_DAYS) return 'lapsing';
  return 'dormant';
}

// Adds parsed dates, days and status to every user row.
function usPrepare(d) {
  var now = new Date();
  var users = (d && d.users) ? d.users : [];
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    u.lastLoginDate = usParseDate(u.lastLogin);
    u.registeredDate = usParseDate(u.registered);
    u.days = usDaysSince(u.lastLoginDate, now);
    u.accountAge = usDaysSince(u.registeredDate, now);
    u.status = usStatusFor(u.days);
  }
  return { users: users, totalUsers: users.length, generatedAt: d ? d.generatedAt : '', error: d ? d.error : '' };
}

function usCounts(users) {
  var c = { active: 0, lapsing: 0, dormant: 0, never: 0, neverOld: 0, total: users.length };
  for (var i = 0; i < users.length; i++) {
    c[users[i].status]++;
    if (users[i].status === 'never' && (users[i].accountAge === null || users[i].accountAge > USERS_NEW_ACCOUNT_DAYS)) c.neverOld++;
  }
  return c;
}

// =====================================================
// Load flow
// =====================================================
function startUsers() {
  var key = 'users';
  captureEntityFilter(key);
  var progressScreen = document.getElementById(key + 'ProgressScreen');
  var progressBar = document.getElementById(key + 'ProgressBar');
  var progressPercent = document.getElementById(key + 'ProgressPercent');
  var progressStatus = document.getElementById(key + 'ProgressStatus');
  var resultsContainer = document.getElementById(key + 'Results');
  var headerBtn = document.getElementById(key + 'AnalyzeBtn');
  var expBtn = document.getElementById(key + 'ExportBtn');

  if (resultsContainer) resultsContainer.style.display = 'none';
  if (expBtn) expBtn.style.display = 'none';
  if (headerBtn) headerBtn.disabled = true;
  if (progressScreen) progressScreen.style.display = '';
  if (progressBar) { progressBar.style.width = '0'; progressBar.classList.add('loading'); }
  if (progressPercent) progressPercent.textContent = '0' + P;
  if (progressStatus) progressStatus.textContent = 'Loading users...';

  usersActivity = null;
  usersActivityState = 'idle';
  usersFilter = 'all';
  usersSearch = '';

  var currentPct = 0;
  var fakeTimer = setInterval(function() {
    if (currentPct < 95) {
      currentPct = Math.min(currentPct + Math.max(0.5, (95 - currentPct) * 0.08), 95);
      if (progressBar) progressBar.style.width = currentPct + P;
      if (progressPercent) progressPercent.textContent = Math.round(currentPct) + P;
    }
  }, 150);

  // Capture the period now, so a later page switch cannot change it mid-flight.
  var dfParam = getDateFilterParam();

  ajax(usersUrl, function(d) {
    clearInterval(fakeTimer);
    usersData = usPrepare(d);
    if (progressBar) { progressBar.style.width = '100' + P; progressBar.classList.remove('loading'); }
    if (progressPercent) progressPercent.textContent = '100' + P;
    if (progressStatus) progressStatus.textContent = d ? 'Complete!' : 'Could not load users';
    renderUsers();
    setTimeout(function() {
      if (progressScreen) progressScreen.style.display = 'none';
      if (resultsContainer) resultsContainer.style.display = '';
      if (expBtn && d) expBtn.style.display = '';
      if (headerBtn) { headerBtn.disabled = false; headerBtn.onclick = function() { startUsers(); }; }
    }, 400);
    if (d && usersData.users.length > 0) usLoadActivity(dfParam);
  });
}

// Per-user activity comes from MomentumFetch, which counts per user and is the
// slow part on large tenants. It loads after the login view is already visible.
function usLoadActivity(dfParam) {
  var amp = String.fromCharCode(38);
  var etParam = '';
  if (typeof daSettings !== 'undefined' && daSettings.getMomentumSettings) {
    var mmS = daSettings.getMomentumSettings();
    if (mmS.excludedTypes && mmS.excludedTypes.length > 0) etParam = amp + 'excludeTypes=' + encodeURIComponent(mmS.excludedTypes.join(','));
  }
  usersActivityState = 'loading';
  usersActivityLabel = (activeFilterLabel && activeFilterLabel['users']) ? activeFilterLabel['users'] : 'All data';
  renderUsers();
  ajax(momentumUrl + amp + 'dummy=1' + dfParam + etParam, function(m) {
    if (!m || !m.users) { usersActivityState = 'failed'; renderUsers(); return; }
    usersActivity = {};
    for (var i = 0; i < m.users.length; i++) {
      var mu = m.users[i];
      usersActivity[mu.id] = { activities: mu.activities || 0, documents: mu.documents || 0, total: mu.total || 0 };
    }
    usersActivityState = 'done';
    renderUsers();
  });
}

function usActivityOf(u) {
  if (!usersActivity) return null;
  return usersActivity[u.id] || { activities: 0, documents: 0, total: 0 };
}

// =====================================================
// Render
// =====================================================
function renderUsers() {
  var el = document.getElementById('usersOverviewContent');
  if (!el || !usersData) return;
  var users = usersData.users;
  if (usersData.error || users.length === 0) {
    el.innerHTML = hcSecLabel('Users') + hcInsight('warn', 'No users could be read.', usEsc(usersData.error || 'The endpoint returned no users that can log in.'));
    return;
  }
  var c = usCounts(users);
  var h = dateFilterNotice();

  h += hcSecLabel('Login activity · users who can log in');
  h += '<div class="kpis" style="grid-template-columns:repeat(5,minmax(0,1fr))">';
  h += ovCard('Users with login', c.total, '', '');
  h += ovCard('Logged in ≤ ' + USERS_ACTIVE_DAYS + ' days', c.active, c.total, '');
  h += ovCard(USERS_ACTIVE_DAYS + 1 + '–' + USERS_DORMANT_DAYS + ' days ago', c.lapsing, c.total, '');
  h += ovCard('More than ' + USERS_DORMANT_DAYS + ' days ago', c.dormant, c.total, '');
  h += ovCard('Never logged in', c.never, c.total, '');
  h += '</div>';

  h += usInsights(users, c);
  h += usGroupTable(users);
  h += '<div id="usersListWrap">' + usListHtml(users, c) + '</div>';
  // The activity load re-renders the page; keep the caret if the user is typing a search.
  var typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#usersListWrap');
  el.innerHTML = h;
  if (typing) {
    var inp = document.querySelector('#usersListWrap input[type=text]');
    if (inp) { inp.focus(); inp.setSelectionRange(usersSearch.length, usersSearch.length); }
  }
}

function usInsights(users, c) {
  var h = '';
  var idle = c.dormant + c.never;
  if (idle > 0) {
    var pct = Math.round(idle / c.total * 100);
    h += hcInsight('warn', fmtNum(idle) + ' of ' + fmtNum(c.total) + ' users (' + pct + P + ')',
      'have not logged in for more than ' + USERS_DORMANT_DAYS + ' days or never logged in. Review whether these accounts still need access and a licence.');
  } else {
    h += hcInsight('good', 'Every user logged in within the last ' + USERS_DORMANT_DAYS + ' days.', '');
  }
  if (c.neverOld > 0) {
    h += hcInsight('neutral', fmtNum(c.neverOld) + ' account' + (c.neverOld !== 1 ? 's' : ''),
      'older than ' + USERS_NEW_ACCOUNT_DAYS + ' days ' + (c.neverOld !== 1 ? 'have' : 'has') + ' never been used. These are often leftovers from onboarding or test accounts.');
  }
  if (usersActivityState === 'loading') {
    h += hcInsight('neutral', 'Loading activity per user…', 'The comparison between logins and registered work appears here when it is ready.');
  } else if (usersActivityState === 'failed') {
    h += hcInsight('neutral', 'Activity per user could not be loaded.', 'The login figures above are complete; only the comparison with registered activities is missing.');
  } else if (usersActivityState === 'done') {
    var loginNoWork = 0, workNoLogin = 0;
    for (var i = 0; i < users.length; i++) {
      var a = usActivityOf(users[i]);
      if (users[i].status === 'active' && a.total === 0) loginNoWork++;
      if ((users[i].status === 'dormant' || users[i].status === 'never') && a.total > 0) workNoLogin++;
    }
    if (loginNoWork > 0) {
      h += hcInsight('primary', fmtNum(loginNoWork) + ' active user' + (loginNoWork !== 1 ? 's' : ''),
        'logged in recently but registered no activities or documents (' + usEsc(usersActivityLabel) + '). They look things up but do not record their work in SuperOffice.');
    }
    if (workNoLogin > 0) {
      h += hcInsight('neutral', fmtNum(workNoLogin) + ' user' + (workNoLogin !== 1 ? 's' : ''),
        'without a recent login do own activities in the period. These are usually created by colleagues, imports, integrations or mail sync.');
    }
  }
  return h;
}

function usGroupTable(users) {
  var byGroup = {}, order = [];
  for (var i = 0; i < users.length; i++) {
    var g = users[i].group || '(No group)';
    if (!byGroup[g]) { byGroup[g] = { name: g, total: 0, active: 0, lapsing: 0, dormant: 0, never: 0 }; order.push(g); }
    byGroup[g].total++;
    byGroup[g][users[i].status]++;
  }
  if (order.length < 2) return '';
  var rows = [];
  for (var j = 0; j < order.length; j++) rows.push(byGroup[order[j]]);
  rows.sort(function(a, b) { return b.total - a.total; });

  var h = '<div class="entity-card">';
  h += '<div class="entity-header"><div class="entity-info"><h3>Login activity by group</h3>';
  h += '<span class="field-count">— primary user group</span></div></div>';
  h += '<table class="data-table"><thead><tr><th>Group</th><th class="col-right">Users</th>';
  h += '<th class="col-right">Active</th><th class="col-right">Lapsing</th><th class="col-right">Dormant</th><th class="col-right">Never</th>';
  h += '<th style="width:200px">Active share</th></tr></thead><tbody>';
  for (var k = 0; k < rows.length; k++) {
    var r = rows[k];
    var pct = r.total > 0 ? Math.round(r.active / r.total * 100) : 0;
    h += '<tr><td><strong>' + usEsc(r.name) + '</strong></td><td class="col-right">' + fmtNum(r.total) + '</td>';
    h += '<td class="col-right">' + fmtNum(r.active) + '</td><td class="col-right">' + fmtNum(r.lapsing) + '</td>';
    h += '<td class="col-right">' + fmtNum(r.dormant) + '</td><td class="col-right">' + fmtNum(r.never) + '</td>';
    h += '<td>' + fillBar(pct, 8, 'var(--c1)') + '<div style="margin-top:4px;font-size:var(--fs-chip);color:var(--muted)">' + pct + P + '</div></td></tr>';
  }
  h += '</tbody></table></div>';
  return h;
}

function usFilteredSorted(users) {
  var q = usersSearch.toLowerCase();
  var out = [];
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (usersFilter !== 'all' && u.status !== usersFilter) continue;
    if (q && (u.name + ' ' + u.login + ' ' + u.group).toLowerCase().indexOf(q) < 0) continue;
    out.push(u);
  }
  var col = usersSort.col, dir = usersSort.asc ? 1 : -1;
  out.sort(function(a, b) {
    var va, vb;
    if (col === 'days') {
      // Never logged in sorts as the longest ago.
      va = a.days === null ? 1e9 : a.days; vb = b.days === null ? 1e9 : b.days;
    } else if (col === 'activity') {
      var aa = usActivityOf(a), ab = usActivityOf(b);
      va = aa ? aa.total : 0; vb = ab ? ab.total : 0;
    } else {
      va = String(a[col] || '').toLowerCase(); vb = String(b[col] || '').toLowerCase();
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  return out;
}

function usListHtml(users, c) {
  var list = usFilteredSorted(users);
  var f = function(key, label, n) {
    return '<button class="btn-s ' + (usersFilter === key ? 'primary' : 'ghost') + '" onclick="usSetFilter(\'' + key + '\')">' + label + ' (' + fmtNum(n) + ')</button>';
  };
  var arrow = function(col) { return usersSort.col === col ? (usersSort.asc ? ' ▲' : ' ▼') : ''; };
  var th = function(col, label, cls) {
    return '<th' + (cls ? ' class="' + cls + '"' : '') + ' style="cursor:pointer;white-space:nowrap" onclick="usSetSort(\'' + col + '\')">' + label + arrow(col) + '</th>';
  };
  var actHead = usersActivityState === 'done' ? 'Activities' : (usersActivityState === 'loading' ? 'Activities…' : 'Activities');

  var h = '<div class="entity-card">';
  h += '<div class="entity-header"><div class="entity-info"><h3>All users</h3>';
  h += '<span class="field-count">— ' + fmtNum(list.length) + ' shown</span></div>';
  h += '<input type="text" placeholder="Search name, login or group" value="' + usEsc(usersSearch) + '" oninput="usSetSearch(this.value)" style="padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-family:inherit;min-width:240px"></div>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px">';
  h += f('all', 'All', c.total) + f('active', 'Active', c.active) + f('lapsing', 'Lapsing', c.lapsing) + f('dormant', 'Dormant', c.dormant) + f('never', 'Never', c.never);
  h += '</div>';
  h += '<table class="data-table"><thead><tr>';
  h += th('name', 'User') + th('login', 'Login') + th('group', 'Group') + '<th>Last login</th>' + th('days', 'Days ago', 'col-right');
  h += '<th>Status</th>' + th('activity', actHead, 'col-right');
  h += '</tr></thead><tbody>';
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    var st = US_STATUS[u.status];
    var a = usActivityOf(u);
    var actCell = a ? fmtNum(a.total) : (usersActivityState === 'loading' ? '…' : '—');
    h += '<tr' + (u.status === 'dormant' || u.status === 'never' ? ' style="opacity:.75"' : '') + '>';
    h += '<td><strong>' + usEsc(u.name) + '</strong></td>';
    h += '<td style="color:var(--muted)">' + usEsc(u.login) + '</td>';
    h += '<td style="color:var(--muted)">' + usEsc(u.group || '—') + '</td>';
    h += '<td>' + (u.lastLoginDate ? usIsoDay(u.lastLoginDate) : '—') + '</td>';
    h += '<td class="col-right">' + (u.days === null ? '—' : fmtNum(u.days)) + '</td>';
    h += '<td><span class="mm-badge" style="background:' + st.bg + ';color:' + st.fg + '">' + st.label + '</span></td>';
    h += '<td class="col-right">' + actCell + '</td></tr>';
  }
  if (list.length === 0) h += '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:18px">No users match this filter.</td></tr>';
  h += '</tbody></table></div>';
  return h;
}

function usRefreshList() {
  var wrap = document.getElementById('usersListWrap');
  if (!wrap || !usersData) return;
  wrap.innerHTML = usListHtml(usersData.users, usCounts(usersData.users));
}
function usSetFilter(key) { usersFilter = key; usRefreshList(); }
function usSetSort(col) {
  if (usersSort.col === col) usersSort.asc = !usersSort.asc;
  else { usersSort.col = col; usersSort.asc = (col !== 'days' && col !== 'activity'); }
  usRefreshList();
}
// Re-rendering the list replaces the input, so focus and caret are restored.
function usSetSearch(v) {
  usersSearch = v;
  usRefreshList();
  var inp = document.querySelector('#usersListWrap input[type=text]');
  if (inp) { inp.focus(); inp.setSelectionRange(v.length, v.length); }
}

// =====================================================
// Export
// =====================================================
function exportUsers() {
  if (!usersData || typeof XLSX === 'undefined') return;
  var users = usersData.users;
  var c = usCounts(users);
  var wb = XLSX.utils.book_new();

  var sum = [
    ['Users login overview'],
    ['Generated', new Date().toISOString().split('T')[0]],
    [],
    ['Users with login', c.total],
    ['Logged in <= ' + USERS_ACTIVE_DAYS + ' days', c.active],
    ['Last login ' + (USERS_ACTIVE_DAYS + 1) + '-' + USERS_DORMANT_DAYS + ' days ago', c.lapsing],
    ['Last login more than ' + USERS_DORMANT_DAYS + ' days ago', c.dormant],
    ['Never logged in', c.never],
    ['Never logged in, account older than ' + USERS_NEW_ACCOUNT_DAYS + ' days', c.neverOld],
    [],
    ['Activities period', usersActivityState === 'done' ? usersActivityLabel : 'not loaded']
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Summary');

  var rows = [['User', 'Login', 'Group', 'Last login', 'Days since login', 'Status', 'Account created', 'Activities', 'Documents', 'Total']];
  var list = users.slice().sort(function(a, b) {
    var va = a.days === null ? 1e9 : a.days, vb = b.days === null ? 1e9 : b.days;
    return vb - va;
  });
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    var a = usActivityOf(u);
    rows.push([u.name, u.login, u.group || '', usIsoDay(u.lastLoginDate), u.days === null ? '' : u.days,
      US_STATUS[u.status].label, usIsoDay(u.registeredDate),
      a ? a.activities : '', a ? a.documents : '', a ? a.total : '']);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Users');

  XLSX.writeFile(wb, 'HealthCheck_Users_' + new Date().toISOString().split('T')[0] + '.xlsx');
}
