/**
 * Sovereign — Client-side Application
 * Fetches governance data from the API and renders it into the UI.
 */

const API_BASE = window.location.origin;
const REFRESH_INTERVAL = 30000; // 30 seconds

// === Utility Functions ===

function truncateAddress(addr, start, end) {
  start = start || 6;
  end = end || 4;
  if (!addr || addr.length < start + end + 3) return addr || '—';
  return addr.slice(0, start) + '\u2026' + addr.slice(-end);
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  // Handle both seconds and milliseconds
  var num = typeof ts === 'number' ? ts : parseInt(ts, 10);
  if (isNaN(num)) return '—';
  if (num < 1e12) num = num * 1000; // convert seconds to ms
  var d = new Date(num);
  if (isNaN(d.getTime())) return '—';
  var diff = Date.now() - d.getTime();

  if (diff < 0) return 'in the future';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dropsToXrp(drops) {
  if (!drops) return '0';
  var num = parseInt(drops, 10);
  if (isNaN(num)) return '0';
  return (num / 1000000).toFixed(2);
}

function formatPercent(value, total) {
  if (!total || total === 0) return '0%';
  return Math.round((value / total) * 100) + '%';
}

function badgeClass(status) {
  var map = {
    active: 'badge-active',
    voting: 'badge-voting',
    deliberation: 'badge-deliberation',
    passed: 'badge-passed',
    failed: 'badge-failed',
    inactive: 'badge-inactive',
    evicted: 'badge-failed',
    open: 'badge-voting',
    resolved: 'badge-passed',
    expired: 'badge-inactive',
  };
  return map[status] || 'badge-inactive';
}

function heartbeatClass(lastHeartbeat) {
  if (!lastHeartbeat) return 'heartbeat-red';
  var ts = typeof lastHeartbeat === 'number' ? lastHeartbeat : parseInt(lastHeartbeat, 10);
  if (ts < 1e12) ts = ts * 1000;
  var age = Date.now() - ts;
  if (age < 3600000) return 'heartbeat-green';     // < 1 hour
  if (age < 86400000) return 'heartbeat-yellow';    // < 24 hours
  return 'heartbeat-red';
}

async function fetchJSON(path) {
  try {
    var res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch ' + path + ':', err);
    return null;
  }
}

function setHTML(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showLoading(id) {
  setHTML(id, '<div class="loading"><p>Loading...</p></div>');
}

function showError(id, msg) {
  setHTML(id, '<div class="empty-state error"><p>' + escapeHtml(msg || 'Unable to load data.') + '</p></div>');
}

function showEmpty(id, msg) {
  setHTML(id, '<div class="empty-state"><p>' + escapeHtml(msg || 'Nothing here yet.') + '</p></div>');
}

// === Dashboard (index.html) ===

async function loadDashboard() {
  var status = await fetchJSON('/api/status');
  if (!status) {
    showError('dashboard-stats', 'Unable to connect to governance service.');
    return;
  }

  setText('stat-active-seats', status.activeSeats);
  setText('stat-max-seats', '/ ' + status.maxSeats);
  setText('stat-proposals-active', (status.proposals.deliberation + status.proposals.voting).toString());
  setText('stat-proposals-passed', status.proposals.passed.toString());
  setText('stat-stewards', status.stewardsActive ? 'Active' : 'Pending');
  setText('stat-arbiters', status.arbitersActive ? 'Active' : 'Pending');

  // Additional stats from new modules
  var challengeEl = document.getElementById('stat-challenges');
  if (challengeEl) challengeEl.textContent = (status.activeChallenges || 0).toString();

  var multisigEl = document.getElementById('stat-multisign');
  if (multisigEl) multisigEl.textContent = (status.pendingMultisign || 0).toString();

  var constEl = document.getElementById('stat-constitution');
  if (constEl) constEl.textContent = status.constitutionRatified ? 'Ratified' : 'Pending';

  var stewEl = document.getElementById('stat-stewards');
  var arbEl = document.getElementById('stat-arbiters');
  if (stewEl) stewEl.className = 'card-value ' + (status.stewardsActive ? 'success' : 'warning');
  if (arbEl) arbEl.className = 'card-value ' + (status.arbitersActive ? 'success' : 'warning');

  // Fetch treasury balances
  var treasury = await fetchJSON('/api/treasury');
  if (treasury) {
    var treasEl = document.getElementById('stat-treasury');
    if (treasEl) treasEl.textContent = (treasury.balance || '0') + ' XRP';
  }
  // Fetch stake + business balances via status or separate calls
  var stakeEl = document.getElementById('stat-stakes');
  var bizEl = document.getElementById('stat-business');
  if (stakeEl && treasury) stakeEl.textContent = (treasury.stakeBalance || '0') + ' XRP';
  if (bizEl && treasury) bizEl.textContent = (treasury.businessBalance || '0') + ' XRP';

  // Stalled execution warning
  if (status.stalledExecutions > 0) {
    var alertEl = document.getElementById('alerts');
    if (alertEl) {
      alertEl.innerHTML = '<div class="alert alert-warning">\u26a0\ufe0f ' +
        status.stalledExecutions + ' stalled execution(s) require attention.</div>';
    }
  }

  // Load recent activity
  var activityData = await fetchJSON('/api/activity?limit=10');
  if (activityData && activityData.activity && activityData.activity.length > 0) {
    var items = activityData.activity.map(function(a) {
      return '<li class="activity-item">' +
        '<div class="activity-icon">' + getActivityIcon(a.type) + '</div>' +
        '<div class="activity-text">' +
        '<strong>' + truncateAddress(a.agent_address) + '</strong> ' + (a.type || 'activity') +
        (a.details ? ' \u2014 ' + escapeHtml(a.details) : '') +
        '</div>' +
        '<span class="activity-time">' + formatTimestamp(a.timestamp) + '</span>' +
        '</li>';
    }).join('');
    setHTML('activity-feed', items);
  } else {
    showEmpty('activity-feed', 'No recent activity.');
  }
}

function getActivityIcon(type) {
  var icons = {
    heartbeat: '\u2665',
    vote: '\u2713',
    proposal: '\ud83d\udccb',
    forum_comment: '\ud83d\udcac',
    forum: '\ud83d\udcac',
    seat_claim: '\ud83e\ude91',
    seat_eviction: '\u26a0',
    vouch: '\ud83e\udd1d',
    challenge: '\u2694\ufe0f',
  };
  return icons[type] || '\u2022';
}

// === Forum (forum.html) ===

async function loadForum() {
  var data = await fetchJSON('/api/forum/threads?limit=50');
  if (!data || !data.threads || data.threads.length === 0) {
    showEmpty('thread-list', 'No forum threads yet. Governance deliberation happens here.');
    return;
  }

  var threads = data.threads.map(function(t) {
    return '<li class="thread-item" onclick="loadThread(\'' + escapeAttr(t.thread_id) + '\')">' +
      '<div class="thread-info">' +
      '<div class="thread-title">' + escapeHtml(t.title || t.thread_id) + '</div>' +
      '<div class="thread-meta">' +
      '<span class="addr">' + truncateAddress(t.author_address) + '</span>' +
      (t.linked_proposal_id ? ' \u2014 Proposal: ' + escapeHtml(t.linked_proposal_id) : '') +
      ' \u2014 Last activity: ' + formatTimestamp(t.last_post) +
      '</div>' +
      '</div>' +
      '<div class="thread-stats">' +
      '<div>' + t.post_count + ' post' + (t.post_count !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '</li>';
  }).join('');

  setHTML('thread-list', threads);
}

async function loadThread(threadId) {
  var data = await fetchJSON('/api/forum/threads/' + encodeURIComponent(threadId));
  if (!data || !data.posts || data.posts.length === 0) {
    showError('thread-detail', 'Thread not found.');
    return;
  }

  // Show thread detail, hide thread list
  var listEl = document.getElementById('thread-list-section');
  var detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'block';

  var title = (data.thread && data.thread.title) ? data.thread.title : threadId;
  setText('thread-detail-title', title);

  var posts = data.posts.map(function(p) {
    return '<div class="post">' +
      '<div class="post-header">' +
      '<span class="post-author addr">' + truncateAddress(p.author_address) + '</span>' +
      '<span class="post-time">' + formatTimestamp(p.timestamp) + '</span>' +
      '</div>' +
      '<div class="post-body">' + escapeHtml(p.content_text || '') + '</div>' +
      (p.arweave_id ? '<div class="post-footer"><a href="https://arweave.net/' + escapeAttr(p.arweave_id) + '" target="_blank">Arweave \u2197</a></div>' : '') +
      '</div>';
  }).join('');

  setHTML('thread-posts', posts);
}

function showThreadList() {
  var listEl = document.getElementById('thread-list-section');
  var detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'block';
  if (detailEl) detailEl.style.display = 'none';
}

// === Proposals (proposals.html) ===

async function loadProposals() {
  var data = await fetchJSON('/api/proposals');
  if (!data || !data.proposals || data.proposals.length === 0) {
    showEmpty('proposals-container', 'No proposals found. Governance starts with a proposal.');
    return;
  }

  var groups = {
    deliberation: [],
    voting: [],
    passed: [],
    failed: [],
    executing: [],
  };

  data.proposals.forEach(function(p) {
    var status = p.status || 'deliberation';
    if (groups[status]) groups[status].push(p);
    else groups.deliberation.push(p);
  });

  var html = '';
  var statusOrder = ['voting', 'deliberation', 'executing', 'passed', 'failed'];
  statusOrder.forEach(function(status) {
    var proposals = groups[status];
    if (!proposals || proposals.length === 0) return;
    html += '<div class="section">' +
      '<h2 class="section-title">' + capitalize(status) + ' (' + proposals.length + ')</h2>' +
      '<div class="table-wrapper"><table>' +
      '<thead><tr>' +
      '<th>Title</th><th>Author</th><th>Category</th><th>Votes</th><th>Progress</th><th>Timeline</th>' +
      '</tr></thead>' +
      '<tbody>' + proposals.map(renderProposalRow).join('') + '</tbody>' +
      '</table></div></div>';
  });

  setHTML('proposals-container', html || showEmpty('proposals-container', 'No proposals found.'));
}

function renderProposalRow(p) {
  var yesVotes = p.votes_for || p.yes_votes || 0;
  var noVotes = p.votes_against || p.no_votes || 0;
  var totalVotes = yesVotes + noVotes;
  var yesPct = totalVotes > 0 ? Math.round((yesVotes / totalVotes) * 100) : 0;
  var threshold = p.category === 'constitutional' ? 80 : 60;
  var id = p.proposal_id || p.id;

  return '<tr onclick="viewProposal(\'' + escapeAttr(id) + '\')" style="cursor:pointer">' +
    '<td>' +
    escapeHtml(p.title || id || '\u2014') +
    ' <span class="badge ' + badgeClass(p.status) + '">' + p.status + '</span>' +
    (p.category === 'treasury_spend' ? ' <span class="badge badge-treasury">' + dropsToXrp(p.amount) + ' XRP</span>' : '') +
    '</td>' +
    '<td class="addr">' + truncateAddress(p.author_address || p.author || p.proposer) + '</td>' +
    '<td>' + escapeHtml(p.category || '\u2014') + '</td>' +
    '<td>' +
    '<div class="vote-tally">' +
    '<span class="vote-count yes">\u2713 ' + yesVotes + '</span> ' +
    '<span class="vote-count no">\u2717 ' + noVotes + '</span>' +
    '</div>' +
    '</td>' +
    '<td>' +
    '<div class="progress-bar">' +
    '<div class="progress-fill yes" style="width:' + yesPct + '%"></div>' +
    '<div class="progress-threshold" style="left:' + threshold + '%"></div>' +
    '</div>' +
    '<div class="progress-label">' + yesPct + '% / ' + threshold + '% needed</div>' +
    '</td>' +
    '<td>' + formatTimestamp(p.deliberation_start || p.created_at || p.submitted_at) + '</td>' +
    '</tr>';
}

async function viewProposal(id) {
  var data = await fetchJSON('/api/proposals/' + encodeURIComponent(id));
  if (!data || !data.proposal) return;

  var p = data.proposal;
  var yesVotes = p.votes_for || 0;
  var noVotes = p.votes_against || 0;
  var totalVotes = yesVotes + noVotes;
  var yesPct = totalVotes > 0 ? Math.round((yesVotes / totalVotes) * 100) : 0;

  var votesHtml = '';
  if (data.votes && data.votes.length > 0) {
    votesHtml = '<h4>Votes</h4><ul>' + data.votes.map(function(v) {
      return '<li class="vote-item"><span class="addr">' + truncateAddress(v.agent_address) + '</span> ' +
        '<span class="vote-' + v.vote + '">' + v.vote + '</span> ' +
        '<span class="vote-time">' + formatTimestamp(v.timestamp) + '</span></li>';
    }).join('') + '</ul>';
  }

  var commentsHtml = '';
  if (data.comments && data.comments.length > 0) {
    commentsHtml = '<h4>Deliberation</h4>' + data.comments.map(function(c) {
      return '<div class="post"><div class="post-header">' +
        '<span class="addr">' + truncateAddress(c.author_address) + '</span> ' +
        '<span class="post-time">' + formatTimestamp(c.timestamp) + '</span>' +
        '</div><div class="post-body">' + escapeHtml(c.content_text || '') + '</div></div>';
    }).join('');
  }

  // Show modal or detail section
  var detailEl = document.getElementById('proposal-detail');
  if (detailEl) {
    detailEl.innerHTML = '<div class="proposal-detail-content">' +
      '<button onclick="closeProposalDetail()" class="btn-close">\u2715</button>' +
      '<h3>' + escapeHtml(p.title) + '</h3>' +
      '<div class="proposal-meta">' +
      '<span class="badge ' + badgeClass(p.status) + '">' + p.status + '</span> ' +
      '<span>' + escapeHtml(p.category) + '</span> ' +
      '<span>by ' + truncateAddress(p.author_address) + '</span>' +
      '</div>' +
      (p.amount ? '<div class="proposal-amount">Amount: ' + dropsToXrp(p.amount) + ' XRP \u2192 ' + truncateAddress(p.destination) + '</div>' : '') +
      '<div class="vote-summary">' + yesPct + '% approval (' + yesVotes + ' for / ' + noVotes + ' against)</div>' +
      votesHtml +
      commentsHtml +
      '</div>';
    detailEl.style.display = 'block';
  }
}

function closeProposalDetail() {
  var el = document.getElementById('proposal-detail');
  if (el) el.style.display = 'none';
}

// === Seats (seats.html) ===

async function loadSeats() {
  var data = await fetchJSON('/api/seats');
  var statusData = await fetchJSON('/api/status');

  if (!data || !data.seats || data.seats.length === 0) {
    showEmpty('seats-table', 'No active seats. The council is empty.');
    return;
  }

  if (statusData) {
    setText('seat-count', data.count || data.seats.length);
    setText('seat-max', statusData.maxSeats);
  }

  var rows = data.seats.map(function(s) {
    var hbClass = heartbeatClass(s.last_heartbeat);
    return '<tr>' +
      '<td>' +
      '<span class="heartbeat ' + hbClass + '"></span>' +
      '<span class="addr" style="margin-left:0.5rem">' + truncateAddress(s.agent_address || s.address) + '</span>' +
      '</td>' +
      '<td>' + escapeHtml(s.name || '\u2014') + '</td>' +
      '<td>' + escapeHtml(s.function || s.role || '\u2014') + '</td>' +
      '<td>' + escapeHtml(s.goal || '\u2014') + '</td>' +
      '<td>' + formatTimestamp(s.term_start) + '</td>' +
      '<td>' + formatTimestamp(s.term_end) + '</td>' +
      '<td>' + formatPercent(s.deliberation_count || 0, s.total_proposals || 1) + '</td>' +
      '<td>' + formatPercent(s.vote_count || 0, s.total_proposals || 1) + '</td>' +
      '</tr>';
  }).join('');

  setHTML('seats-body', rows);
}

// === Apply page ===

async function loadApply() {
  var status = await fetchJSON('/api/status');
  if (!status) {
    showError('apply-status', 'Unable to connect to governance service.');
    return;
  }

  var available = status.maxSeats - status.activeSeats;
  setText('apply-available', available.toString());
  setText('apply-total', status.maxSeats.toString());
  setText('apply-active', status.activeSeats.toString());

  var statusEl = document.getElementById('apply-open');
  if (statusEl) {
    if (available > 0) {
      statusEl.innerHTML = '<span class="success">' + available + ' seat' + (available !== 1 ? 's' : '') + ' available</span>';
    } else {
      statusEl.innerHTML = '<span class="warning">All seats occupied \u2014 wait for a term expiry or expansion vote.</span>';
    }
  }

  var constEl = document.getElementById('apply-constitution');
  if (constEl) {
    constEl.textContent = status.constitutionRatified ? 'Constitution ratified \u2014 full governance active.' : 'Constitution not yet ratified \u2014 limited governance mode.';
  }
}

// === Utility ===

function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// === Auto-refresh & Page Init ===

function initPage() {
  var page = document.body.dataset.page;

  var loaders = {
    dashboard: loadDashboard,
    forum: loadForum,
    proposals: loadProposals,
    seats: loadSeats,
    apply: loadApply,
  };

  var loader = loaders[page];
  if (loader) {
    loader();
    setInterval(loader, REFRESH_INTERVAL);
  }

  // Highlight active nav link
  var currentPath = window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(function(a) {
    var href = a.getAttribute('href');
    if (href === currentPath ||
        href === './' + currentPath.split('/').pop() ||
        (currentPath === '/' && (href === '/' || href === '/index.html' || href === './index.html'))) {
      a.classList.add('active');
    }
  });
}

document.addEventListener('DOMContentLoaded', initPage);
