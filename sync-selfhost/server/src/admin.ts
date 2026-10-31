interface StatsDb {
  prepare(
    sql: string
  ): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface AdminStats {
  users: {
    total: number;
    artists: number;
    curators: number;
    signupsByDay: Array<{ day: string; count: number }>;
  };
  recentUsers: Array<{
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

export function getAdminStats(db: StatsDb): AdminStats {
  const total = count(db, "SELECT COUNT(*) AS c FROM users");
  const artists = count(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'artist'");
  const curators = count(db, "SELECT COUNT(*) AS c FROM users WHERE role = 'curator'");

  const cutoff = Date.now() - 30 * 86400 * 1000;
  const rows = db
    .prepare(
      "SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY day ORDER BY day"
    )
    .all(cutoff) as Array<{ day: string; c: number }>;
  const byDayMap = new Map(rows.map((r) => [r.day, r.c]));
  const signupsByDay: Array<{ day: string; count: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const day = d.toISOString().slice(0, 10);
    signupsByDay.push({ day, count: byDayMap.get(day) ?? 0 });
  }

  const recentUsers = db
    .prepare(
      "SELECT username, role, email, created_at AS createdAt, last_sign_in_at AS lastSignInAt FROM users ORDER BY created_at DESC LIMIT 25"
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

  const messages = count(db, "SELECT COUNT(*) AS c FROM collaboration_messages");
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
    users: { total, artists, curators, signupsByDay },
    recentUsers,
    campaigns: { total: campaignTotal, byStatus: campaignsByStatus },
    collaborations: { total: collabTotal, byStatus: collabsByStatus },
    messages,
    draftsReady,
    reports: { total: reportsTotal, unemailed: reportsUnemailed },
  };
}

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sync Analytics</title>
<style>
:root { --bg: #0a0c0e; --panel: #121518; --line: #232a30; --text: #e8ecef; --dim: #8b949c; --green: #a8e10c; --green-dim: #5c7a06; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
header.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
header.top h1 { margin: 0; font-size: 26px; letter-spacing: -0.5px; }
header.top h1 span { color: var(--green); }
header.top p { margin: 4px 0 0; color: var(--dim); font-size: 13px; }
button { cursor: pointer; }
.btn { background: var(--green); color: #0a0c0e; border: 0; border-radius: 8px; padding: 10px 18px; font-weight: 700; font-size: 14px; }
.btn.ghost { background: transparent; color: var(--green); border: 1px solid var(--green-dim); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 28px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.card strong { display: block; font-size: 30px; color: var(--green); }
.card span { color: var(--dim); font-size: 13px; }
section.block { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
section.block h2 { margin: 0 0 14px; font-size: 16px; }
.chart { display: flex; align-items: flex-end; gap: 4px; height: 140px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bar { width: 100%; max-width: 22px; background: var(--green); border-radius: 3px 3px 0 0; min-height: 2px; opacity: 0.9; }
.bar.zero { background: var(--line); }
.bar-col small { color: var(--dim); font-size: 9px; margin-top: 4px; transform: rotate(-45deg); transform-origin: top left; white-space: nowrap; }
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
#gate .err { color: #ff7a7a; font-size: 13px; min-height: 20px; margin-bottom: 8px; }
.statusline { display: flex; gap: 18px; flex-wrap: wrap; color: var(--dim); font-size: 13px; }
.statusline b { color: var(--text); }
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
  <div class="cards" id="cards"></div>
  <section class="block"><h2>Signups — last 30 days</h2><div class="chart" id="chart"></div></section>
  <section class="block"><h2>Recent users</h2><div style="overflow-x:auto"><table id="users"><thead><tr><th>Username</th><th>Role</th><th>Email</th><th>Signed up</th><th>Last seen</th></tr></thead><tbody></tbody></table></div></section>
  <section class="block"><h2>Activity</h2><div class="statusline" id="activity"></div></section>
</div>
<script>
(function () {
  var gate = document.getElementById('gate');
  var dash = document.getElementById('dash');
  var err = document.getElementById('gate-err');
  function fmtDate(ms) { if (!ms) return '—'; return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  async function load() {
    var key = sessionStorage.getItem('sync_admin_key') || '';
    var res = await fetch('/admin/stats', { headers: { 'x-admin-key': key } });
    if (res.status === 401) { gate.hidden = false; dash.hidden = true; err.textContent = key ? 'Wrong key.' : ''; return; }
    if (!res.ok) { err.textContent = 'Could not load stats.'; gate.hidden = false; dash.hidden = true; return; }
    var s = await res.json();
    gate.hidden = true; dash.hidden = false;
    render(s);
  }
  function render(s) {
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    var cards = [
      [s.users.total, 'total users'],
      [s.users.artists, 'artists'],
      [s.users.curators, 'curators'],
      [s.campaigns.total, 'campaigns'],
      [s.collaborations.total, 'collaborations'],
      [s.messages, 'messages sent']
    ];
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><strong>' + c[0] + '</strong><span>' + c[1] + '</span></div>';
    }).join('');
    var days = s.users.signupsByDay;
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));
    document.getElementById('chart').innerHTML = days.map(function (d) {
      var h = Math.max(2, Math.round(d.count / max * 110));
      return '<div class="bar-col" title="' + d.day + ': ' + d.count + '"><div class="bar' + (d.count ? '' : ' zero') + '" style="height:' + h + 'px"></div><small>' + d.day.slice(5) + '</small></div>';
    }).join('');
    document.querySelector('#users tbody').innerHTML = s.recentUsers.map(function (u) {
      return '<tr><td>@' + esc(u.username) + '</td><td><span class="pill ' + esc(u.role) + '">' + esc(u.role) + '</span></td><td>' + esc(u.email) + '</td><td>' + fmtDate(u.createdAt) + '</td><td>' + fmtDate(u.lastSignInAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--dim)">No users yet.</td></tr>';
    function breakdown(label, obj) {
      var parts = Object.keys(obj).map(function (k) { return k + ': <b>' + obj[k] + '</b>'; });
      return '<span>' + esc(label) + ' — ' + (parts.join(' · ') || 'none') + '</span>';
    }
    document.getElementById('activity').innerHTML =
      breakdown('Campaigns', s.campaigns.byStatus) +
      breakdown('Collaborations', s.collaborations.byStatus) +
      '<span>Drafts ready: <b>' + s.draftsReady + '</b></span>' +
      '<span>Reports: <b>' + s.reports.total + '</b> (' + s.reports.unemailed + ' unemailed)</span>';
  }
  document.getElementById('unlock').addEventListener('click', function () {
    var v = document.getElementById('key').value;
    sessionStorage.setItem('sync_admin_key', v);
    load();
  });
  document.getElementById('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('unlock').click(); });
  document.getElementById('refresh').addEventListener('click', load);
  if (sessionStorage.getItem('sync_admin_key')) load();
})();
</script>
</body>
</html>`;
