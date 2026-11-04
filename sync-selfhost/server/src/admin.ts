interface StatsDb {
  prepare(
    sql: string
  ): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export interface AdminStats {
  users: {
    total: number;
    artists: number;
    curators: number;
    activeDay: number;
    activeWeek: number;
    activityByDay: Array<{
      day: string;
      signups: number;
      campaigns: number;
      invites: number;
      messages: number;
    }>;
  };
  recentUsers: Array<{
    id: number;
    username: string;
    role: string;
    email: string;
    createdAt: number;
    lastSignInAt: number;
  }>;
  campaigns: { total: number; byStatus: Record<string, number> };
  collaborations: { total: number; byStatus: Record<string, number> };
  messages: number;
  draftsReady: number;
  reports: { total: number; unemailed: number };
}

function count(db: StatsDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function dayCounts(
  db: StatsDb,
  table: string,
  column: string,
  cutoff: number
): Map<string, number> {
  const rows = db
    .prepare(
      "SELECT date(" +
        column +
        "/1000, 'unixepoch') AS day, COUNT(*) AS c FROM " +
        table +
        " WHERE " +
        column +
        " >= ? GROUP BY day"
    )
    .all(cutoff) as Array<{ day: string; c: number }>;
  return new Map(rows.map((r) => [r.day, r.c]));
}

export function getAdminStats(db: StatsDb): AdminStats {
  const total = count(db, "SELECT COUNT(*) AS c FROM users");
  const artists = count(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'artist'");
  const curators = count(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'curator'");
  const now = Date.now();
  const activeDay = count(
    db,
    "SELECT COUNT(*) AS c FROM users WHERE last_sign_in_at >= ?",
    now - 86400 * 1000
  );
  const activeWeek = count(
    db,
    "SELECT COUNT(*) AS c FROM users WHERE last_sign_in_at >= ?",
    now - 7 * 86400 * 1000
  );

  const cutoff = now - 30 * 86400 * 1000;
  const signups = dayCounts(db, "users", "created_at", cutoff);
  const campaigns = dayCounts(db, "campaigns", "created_at", cutoff);
  const invites = dayCounts(db, "collaborations", "created_at", cutoff);
  const messages = dayCounts(db, "collaboration_messages", "created_at", cutoff);
  const activityByDay: AdminStats["users"]["activityByDay"] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * 86400 * 1000).toISOString().slice(0, 10);
    activityByDay.push({
      day,
      signups: signups.get(day) ?? 0,
      campaigns: campaigns.get(day) ?? 0,
      invites: invites.get(day) ?? 0,
      messages: messages.get(day) ?? 0,
    });
  }

  const recentUsers = db
    .prepare(
      "SELECT id, username, role, email, created_at AS createdAt, last_sign_in_at AS lastSignInAt FROM users ORDER BY created_at DESC LIMIT 25"
    )
    .all() as AdminStats["recentUsers"];

  const campaignRows = db
    .prepare("SELECT status, COUNT(*) AS c FROM campaigns GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const campaignsByStatus: Record<string, number> = {};
  let campaignTotal = 0;
  for (const r of campaignRows) {
    campaignsByStatus[r.status] = r.c;
    campaignTotal += r.c;
  }

  const collabRows = db
    .prepare("SELECT status, COUNT(*) AS c FROM collaborations GROUP BY status")
    .all() as Array<{ status: string; c: number }>;
  const collabsByStatus: Record<string, number> = {};
  let collabTotal = 0;
  for (const r of collabRows) {
    collabsByStatus[r.status] = r.c;
    collabTotal += r.c;
  }

  const messageTotal = count(db, "SELECT COUNT(*) AS c FROM collaboration_messages");
  const draftsReady = count(
    db,
    "SELECT COUNT(*) AS c FROM collaboration_workspaces WHERE draft_ready = 1"
  );
  const reportsTotal = count(db, "SELECT COUNT(*) AS c FROM user_reports");
  const reportsUnemailed = count(
    db,
    "SELECT COUNT(*) AS c FROM user_reports WHERE emailed = 0"
  );

  return {
    users: { total, artists, curators, activeDay, activeWeek, activityByDay },
    recentUsers,
    campaigns: { total: campaignTotal, byStatus: campaignsByStatus },
    collaborations: { total: collabTotal, byStatus: collabsByStatus },
    messages: messageTotal,
    draftsReady,
    reports: { total: reportsTotal, unemailed: reportsUnemailed },
  };
}

export interface AdminUserRow {
  id: number;
  username: string;
  role: string;
  email: string;
  createdAt: number;
  lastSignInAt: number;
}

export function searchAdminUsers(db: StatsDb, query: string): AdminUserRow[] {
  const q = "%" + query.trim().toLowerCase() + "%";
  const sql = query.trim()
    ? "SELECT id, username, role, email, created_at AS createdAt, last_sign_in_at AS lastSignInAt FROM users WHERE lower(username) LIKE ? OR lower(email) LIKE ? ORDER BY created_at DESC LIMIT 50"
    : "SELECT id, username, role, email, created_at AS createdAt, last_sign_in_at AS lastSignInAt FROM users ORDER BY created_at DESC LIMIT 50";
  const params = query.trim() ? [q, q] : [];
  return db.prepare(sql).all(...params) as AdminUserRow[];
}

export interface AdminCampaignRow {
  id: number;
  title: string;
  status: string;
  owner: string;
  createdAt: number;
}

export function listAdminCampaigns(db: StatsDb): AdminCampaignRow[] {
  return db
    .prepare(
      "SELECT c.id, c.title, c.status, u.username AS owner, c.created_at AS createdAt FROM campaigns c JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC LIMIT 50"
    )
    .all() as AdminCampaignRow[];
}

export interface AdminReportRow {
  id: number;
  reason: string;
  text: string;
  reporter: string;
  target: string;
  emailed: number;
  createdAt: number;
}

export function listAdminReports(db: StatsDb): AdminReportRow[] {
  return db
    .prepare(
      "SELECT r.id, r.reason, r.details AS text, ru.username AS reporter, tu.username AS target, r.emailed, r.created_at AS createdAt FROM user_reports r JOIN users ru ON ru.id = r.reporter_user_id JOIN users tu ON tu.id = r.target_user_id ORDER BY r.created_at DESC LIMIT 50"
    )
    .all() as AdminReportRow[];
}

export interface AdminFeedbackRow {
  id: number;
  username: string;
  message: string;
  createdAt: number;
}

export function listAdminFeedback(db: StatsDb): AdminFeedbackRow[] {
  return db
    .prepare(
      "SELECT f.id, u.username, f.message, f.created_at AS createdAt FROM site_feedback f JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 50"
    )
    .all() as AdminFeedbackRow[];
}

export function deleteAdminUser(db: StatsDb, userId: number): boolean {
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(userId) as {
    changes: number;
  };
  return result.changes > 0;
}

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sync Analytics</title>
<style>
:root { --bg: #0a0c0e; --panel: #121518; --line: #232a30; --text: #e8ecef; --dim: #8b949c; --green: #a8e10c; --green-dim: #5c7a06; --red: #ff7a7a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
header.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
header.top h1 { margin: 0; font-size: 26px; letter-spacing: -0.5px; }
header.top h1 span { color: var(--green); }
header.top p { margin: 4px 0 0; color: var(--dim); font-size: 13px; }
button { cursor: pointer; }
.btn { background: var(--green); color: #0a0c0e; border: 0; border-radius: 8px; padding: 10px 18px; font-weight: 700; font-size: 14px; }
.btn.ghost { background: transparent; color: var(--green); border: 1px solid var(--green-dim); }
.btn.danger { background: transparent; color: var(--red); border: 1px solid #5c2323; padding: 6px 12px; font-size: 12px; border-radius: 6px; }
.btn.small { padding: 6px 12px; font-size: 12px; border-radius: 6px; }
.nav { display: flex; gap: 6px; margin-bottom: 24px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.nav button { background: transparent; border: 0; color: var(--dim); font-size: 15px; font-weight: 600; padding: 8px 16px; border-radius: 8px; }
.nav button.active { color: var(--green); background: #1a2012; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.card strong { display: block; font-size: 28px; color: var(--green); }
.card span { color: var(--dim); font-size: 13px; }
section.block { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
section.block h2 { margin: 0 0 14px; font-size: 16px; display: flex; align-items: center; justify-content: space-between; }
.tabs { display: flex; gap: 8px; }
.tabs button { background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 20px; padding: 6px 14px; font-size: 12px; }
.tabs button.active { color: var(--green); border-color: var(--green-dim); }
.chart { display: flex; align-items: flex-end; gap: 4px; height: 140px; margin-top: 12px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bar { width: 100%; max-width: 22px; background: var(--green); border-radius: 3px 3px 0 0; min-height: 2px; opacity: 0.9; }
.bar.zero { background: var(--line); }
.bar-col small { color: var(--dim); font-size: 9px; margin-top: 4px; white-space: nowrap; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--dim); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; border: 1px solid var(--line); }
.pill.artist { color: var(--green); border-color: var(--green-dim); }
.pill.curator { color: #c4a5ff; border-color: #4a3a6e; }
#gate { max-width: 380px; margin: 120px auto; text-align: center; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 36px 28px; }
#gate h1 { margin: 0 0 8px; font-size: 22px; }
#gate p { color: var(--dim); font-size: 13px; margin: 0 0 20px; }
#gate input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 14px; margin-bottom: 12px; }
#gate .err { color: var(--red); font-size: 13px; min-height: 20px; margin-bottom: 8px; }
.statusline { display: flex; gap: 18px; flex-wrap: wrap; color: var(--dim); font-size: 13px; }
.statusline b { color: var(--text); }
.searchrow { display: flex; gap: 10px; margin-bottom: 12px; }
.searchrow input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 14px; }
.empty { color: var(--dim); font-size: 13px; padding: 12px 0; }
.page[hidden] { display: none; }
</style>
</head>
<body>
<div id="gate">
  <h1>Sync Analytics</h1>
  <p>Private dashboard. Enter the admin key.</p>
  <div class="err" id="gate-err"></div>
  <input type="password" id="key" placeholder="Admin key" autocomplete="off">
  <button class="btn" id="unlock" style="width:100%">Open dashboard</button>
</div>
<div class="wrap" id="dash" hidden>
  <header class="top">
    <div><h1>Sync <span>Analytics</span></h1><p id="updated"></p></div>
    <button class="btn ghost" id="refresh">Refresh</button>
  </header>
  <nav class="nav" id="main-nav">
    <button data-page="overview" class="active">Overview</button>
    <button data-page="users">Users</button>
    <button data-page="campaigns">Campaigns</button>
    <button data-page="reports">Reports</button>
  </nav>

  <div class="page" id="page-overview">
    <div class="cards" id="cards"></div>
    <section class="block">
      <h2>Activity — last 30 days <span class="tabs" id="chart-tabs"></span></h2>
      <div class="chart" id="chart"></div>
    </section>
    <section class="block"><h2>Totals</h2><div class="statusline" id="activity"></div></section>
  </div>

  <div class="page" id="page-users" hidden>
    <section class="block">
      <h2>Users</h2>
      <div class="searchrow"><input id="user-q" placeholder="Search username or email…"><button class="btn small" id="user-search">Search</button></div>
      <div style="overflow-x:auto"><table id="users"><thead><tr><th>Username</th><th>Role</th><th>Email</th><th>Signed up</th><th>Last seen</th><th></th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>

  <div class="page" id="page-campaigns" hidden>
    <section class="block">
      <h2>Campaigns</h2>
      <div style="overflow-x:auto"><table id="campaigns"><thead><tr><th>Title</th><th>Owner</th><th>Status</th><th>Created</th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>

  <div class="page" id="page-reports" hidden>
    <section class="block">
      <h2>Reports</h2>
      <div style="overflow-x:auto"><table id="reports"><thead><tr><th>Reporter</th><th>Target</th><th>Reason</th><th>Emailed</th><th>Date</th></tr></thead><tbody></tbody></table></div>
    </section>
    <section class="block">
      <h2>Site feedback</h2>
      <div style="overflow-x:auto"><table id="feedback"><thead><tr><th>From</th><th>Message</th><th>Date</th></tr></thead><tbody></tbody></table></div>
    </section>
  </div>
</div>
<script>
(function () {
  var gate = document.getElementById('gate');
  var dash = document.getElementById('dash');
  var err = document.getElementById('gate-err');
  var chartMetric = 'signups';
  var lastStats = null;
  function key() { return sessionStorage.getItem('sync_admin_key') || ''; }
  function headers() { return { 'x-admin-key': key() }; }
  function fmtDate(ms) { if (!ms) return '—'; return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ headers: headers() }, opts || {}));
    if (res.status === 401) { gate.hidden = false; dash.hidden = true; err.textContent = key() ? 'Wrong key.' : ''; throw new Error('unauthorized'); }
    if (!res.ok) throw new Error('request failed');
    return res.json();
  }
  function showPage(name) {
    Array.prototype.forEach.call(document.querySelectorAll('#main-nav button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-page') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) {
      p.hidden = p.id !== 'page-' + name;
    });
  }
  async function load() {
    try {
      var s = await api('/admin/stats');
      lastStats = s;
      gate.hidden = true; dash.hidden = false;
      renderStats(s);
      await Promise.all([loadUsers(), loadCampaigns(), loadReports()]);
    } catch (e) { /* gate shown on 401 */ }
  }
  function renderStats(s) {
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    var cards = [
      [s.users.total, 'total users'],
      [s.users.activeDay, 'active today'],
      [s.users.activeWeek, 'active this week'],
      [s.users.artists, 'artists'],
      [s.users.curators, 'curators'],
      [s.campaigns.total, 'campaigns'],
      [s.collaborations.total, 'collaborations'],
      [s.messages, 'messages sent']
    ];
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><strong>' + c[0] + '</strong><span>' + c[1] + '</span></div>';
    }).join('');
    var metrics = [['signups', 'Signups'], ['campaigns', 'Campaigns'], ['invites', 'Invites'], ['messages', 'Messages']];
    document.getElementById('chart-tabs').innerHTML = metrics.map(function (m) {
      return '<button data-m="' + m[0] + '" class="' + (chartMetric === m[0] ? 'active' : '') + '">' + m[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#chart-tabs button'), function (b) {
      b.addEventListener('click', function () { chartMetric = b.getAttribute('data-m'); renderStats(lastStats); });
    });
    var days = s.users.activityByDay;
    var max = Math.max.apply(null, days.map(function (d) { return d[chartMetric]; }).concat([1]));
    document.getElementById('chart').innerHTML = days.map(function (d) {
      var v = d[chartMetric];
      var h = Math.max(2, Math.round(v / max * 110));
      return '<div class="bar-col" title="' + d.day + ': ' + v + '"><div class="bar' + (v ? '' : ' zero') + '" style="height:' + h + 'px"></div><small>' + d.day.slice(5) + '</small></div>';
    }).join('');
    function breakdown(label, obj) {
      var parts = Object.keys(obj).map(function (k) { return k + ': <b>' + obj[k] + '</b>'; });
      return '<span>' + esc(label) + ' — ' + (parts.join(' · ') || 'none') + '</span>';
    }
    document.getElementById('activity').innerHTML =
      breakdown('Campaigns', s.campaigns.byStatus) +
      breakdown('Collaborations', s.collaborations.byStatus) +
      '<span>Drafts ready: <b>' + s.draftsReady + '</b></span>' +
      '<span>Reports: <b>' + s.reports.total + '</b> (' + s.reports.unemailed + ' unemailed)</span>';
    renderUserRows(s.recentUsers);
  }
  function renderUserRows(users) {
    document.querySelector('#users tbody').innerHTML = users.map(function (u) {
      return '<tr><td>@' + esc(u.username) + '</td><td><span class="pill ' + esc(u.role) + '">' + esc(u.role) + '</span></td><td>' + esc(u.email) + '</td><td>' + fmtDate(u.createdAt) + '</td><td>' + fmtDate(u.lastSignInAt) + '</td>' +
        '<td><button class="btn danger" data-del="' + u.id + '" data-name="' + esc(u.username) + '">Delete</button></td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No users found.</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Delete @' + b.getAttribute('data-name') + '? Everything of theirs goes too.')) return;
        try { await api('/admin/users/' + b.getAttribute('data-del') + '/delete', { method: 'POST' }); load(); }
        catch (e) { alert('Delete failed.'); }
      });
    });
  }
  async function loadUsers() {
    var q = document.getElementById('user-q').value;
    var data = await api('/admin/users?q=' + encodeURIComponent(q));
    renderUserRows(data.users);
  }
  async function loadCampaigns() {
    var data = await api('/admin/campaigns');
    document.querySelector('#campaigns tbody').innerHTML = data.campaigns.map(function (c) {
      return '<tr><td>' + esc(c.title) + '</td><td>@' + esc(c.owner) + '</td><td>' + esc(c.status) + '</td><td>' + fmtDate(c.createdAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">No campaigns yet.</td></tr>';
  }
  async function loadReports() {
    var data = await api('/admin/reports');
    document.querySelector('#reports tbody').innerHTML = data.reports.map(function (r) {
      return '<tr><td>@' + esc(r.reporter) + '</td><td>@' + esc(r.target) + '</td><td>' + esc(r.reason) + '</td><td>' + (r.emailed ? 'yes' : 'no') + '</td><td>' + fmtDate(r.createdAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No reports.</td></tr>';
    var fb = await api('/admin/feedback');
    document.querySelector('#feedback tbody').innerHTML = fb.feedback.map(function (f) {
      return '<tr><td>@' + esc(f.username) + '</td><td>' + esc(f.message) + '</td><td>' + fmtDate(f.createdAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="empty">No feedback yet.</td></tr>';
  }
  document.getElementById('unlock').addEventListener('click', function () {
    sessionStorage.setItem('sync_admin_key', document.getElementById('key').value);
    load();
  });
  document.getElementById('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('unlock').click(); });
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('user-search').addEventListener('click', loadUsers);
  document.getElementById('user-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadUsers(); });
  Array.prototype.forEach.call(document.querySelectorAll('#main-nav button'), function (b) {
    b.addEventListener('click', function () { showPage(b.getAttribute('data-page')); });
  });
  if (key()) load();
})();
</script>
</body>
</html>`;
