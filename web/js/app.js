/**
 * Sovereign — Client-side Application
 * Fetches governance data from the API and renders it into the UI.
 */

const API_BASE = window.location.origin;
const REFRESH_INTERVAL = 30000; // 30 seconds

// === Utility Functions ===

function truncateAddress(addr, start = 6, end = 4) {
  if (!addr || addr.length < start + end + 3) return addr || '—';
  return `${addr.slice(0, start)}…${addr.slice(-end)}`;
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : parseInt(ts));
  if (isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPercent(value, total) {
  if (!total || total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function badgeClass(status) {
  const map = {
    active: 'badge-active',
    voting: 'badge-voting',
    deliberation: 'badge-deliberation',
    passed: 'badge-passed',
    failed: 'badge-failed',
    inactive: 'badge-inactive',
    evicted: 'badge-failed',
  };
  return map[status] || 'badge-inactive';
}

function heartbeatClass(lastHeartbeat) {
  if (!lastHeartbeat) return 'heartbeat-red';
  const age = Date.now() - new Date(lastHeartbeat).getTime();
  if (age < 3600000) return 'heartbeat-green';     // < 1 hour
  if (age < 86400000) return 'heartbeat-yellow';    // < 24 hours
  return 'heartbeat-red';
}

async function fetchJSON(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch ${path}:`, err);
    return null;
  }
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// === Dashboard (index.html) ===

async function loadDashboard() {
  const status = await fetchJSON('/api/status');
  if (!status) {
    setHTML('dashboard-stats', '<div class="empty-state"><p>Unable to connect to governance service.</p></div>');
    return;
  }

  setText('stat-active-seats', status.activeSeats);
  setText('stat-max-seats', `/ ${status.maxSeats}`);
  setText('stat-proposals-active', (status.proposals.deliberation + status.proposals.voting).toString());
  setText('stat-proposals-passed', status.proposals.passed.toString());
  setText('stat-stewards', status.stewardsActive ? 'Active' : 'Pending');
  setText('stat-arbiters', status.arbitersActive ? 'Active' : 'Pending');

  const stewEl = document.getElementById('stat-stewards');
  const arbEl = document.getElementById('stat-arbiters');
  if (stewEl) stewEl.className = `card-value ${status.stewardsActive ? 'success' : 'warning'}`;
  if (arbEl) arbEl.className = `card-value ${status.arbitersActive ? 'success' : 'warning'}`;

  // Load recent activity
  const activityData = await fetchJSON('/api/activity?limit=10');
  if (activityData && activityData.activity) {
    const items = activityData.activity.map(a => `
      <li class="activity-item">
        <div class="activity-icon">${getActivityIcon(a.type)}</div>
        <div class="activity-text">
          <strong>${truncateAddress(a.agent_address)}</strong> ${a.type || 'activity'}
          ${a.details ? `— ${a.details}` : ''}
        </div>
        <span class="activity-time">${formatTimestamp(a.timestamp)}</span>
      </li>
    `).join('');
    setHTML('activity-feed', items || '<li class="empty-state"><p>No recent activity.</p></li>');
  }
}

function getActivityIcon(type) {
  const icons = {
    heartbeat: '♥',
    vote: '✓',
    proposal: '📋',
    forum: '💬',
    seat_claim: '🪑',
    seat_eviction: '⚠',
  };
  return icons[type] || '•';
}

// === Forum (forum.html) ===

async function loadForum() {
  const data = await fetchJSON('/api/forum/threads?limit=50');
  if (!data || !data.threads) {
    setHTML('thread-list', '<div class="empty-state"><p>No forum threads yet.</p></div>');
    return;
  }

  const threads = data.threads.map(t => `
    <li class="thread-item" onclick="loadThread('${t.thread_id}')">
      <div class="thread-info">
        <div class="thread-title">${escapeHtml(t.thread_id)}</div>
        <div class="thread-meta">Last activity: ${formatTimestamp(t.last_post)}</div>
      </div>
      <div class="thread-stats">
        <div>${t.post_count} post${t.post_count !== 1 ? 's' : ''}</div>
      </div>
    </li>
  `).join('');

  setHTML('thread-list', threads);
}

async function loadThread(threadId) {
  const data = await fetchJSON(`/api/forum/threads/${encodeURIComponent(threadId)}`);
  if (!data || !data.posts || data.posts.length === 0) {
    setHTML('thread-detail', '<div class="empty-state"><p>Thread not found.</p></div>');
    return;
  }

  // Show thread detail, hide thread list
  const listEl = document.getElementById('thread-list-section');
  const detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'block';

  setText('thread-detail-title', threadId);

  const posts = data.posts.map(p => `
    <div class="post">
      <div class="post-header">
        <span class="post-author addr">${truncateAddress(p.author)}</span>
        <span class="post-time">${formatTimestamp(p.timestamp)}</span>
      </div>
      <div class="post-body">${escapeHtml(p.content || p.body || '')}</div>
    </div>
  `).join('');

  setHTML('thread-posts', posts);
}

function showThreadList() {
  const listEl = document.getElementById('thread-list-section');
  const detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'block';
  if (detailEl) detailEl.style.display = 'none';
}

// === Proposals (proposals.html) ===

async function loadProposals() {
  const data = await fetchJSON('/api/proposals');
  if (!data || !data.proposals) {
    setHTML('proposals-container', '<div class="empty-state"><p>No proposals found.</p></div>');
    return;
  }

  const groups = {
    deliberation: [],
    voting: [],
    passed: [],
    failed: [],
  };

  data.proposals.forEach(p => {
    const status = p.status || 'deliberation';
    if (groups[status]) groups[status].push(p);
    else groups.deliberation.push(p);
  });

  let html = '';
  for (const [status, proposals] of Object.entries(groups)) {
    if (proposals.length === 0) continue;
    html += `<div class="section">
      <h2 class="section-title">${capitalize(status)} (${proposals.length})</h2>
      <div class="table-wrapper"><table>
        <thead><tr>
          <th>Title</th><th>Author</th><th>Category</th><th>Votes</th><th>Timeline</th>
        </tr></thead>
        <tbody>${proposals.map(p => renderProposalRow(p)).join('')}</tbody>
      </table></div>
    </div>`;
  }

  setHTML('proposals-container', html || '<div class="empty-state"><p>No proposals found.</p></div>');
}

function renderProposalRow(p) {
  const yesVotes = p.yes_votes || 0;
  const noVotes = p.no_votes || 0;
  const totalVotes = yesVotes + noVotes;
  const yesPct = totalVotes > 0 ? Math.round((yesVotes / totalVotes) * 100) : 0;

  return `<tr>
    <td>
      <a href="javascript:void(0)" onclick="viewProposal('${p.id || p.proposal_id}')">${escapeHtml(p.title || p.id || '—')}</a>
      <span class="badge ${badgeClass(p.status)}">${p.status}</span>
    </td>
    <td class="addr">${truncateAddress(p.author || p.proposer)}</td>
    <td>${escapeHtml(p.category || '—')}</td>
    <td>
      <div class="vote-tally">
        <span class="vote-count yes">✓ ${yesVotes}</span>
        <span class="vote-count no">✗ ${noVotes}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill yes" style="width: ${yesPct}%"></div>
      </div>
    </td>
    <td>${formatTimestamp(p.created_at || p.submitted_at)}</td>
  </tr>`;
}

async function viewProposal(id) {
  const data = await fetchJSON(`/api/proposals/${encodeURIComponent(id)}`);
  if (!data || !data.proposal) return;
  // For now, show in alert — future: modal or dedicated view
  console.log('Proposal detail:', data);
}

// === Seats (seats.html) ===

async function loadSeats() {
  const data = await fetchJSON('/api/seats');
  const statusData = await fetchJSON('/api/status');

  if (!data || !data.seats) {
    setHTML('seats-table', '<div class="empty-state"><p>No active seats.</p></div>');
    return;
  }

  if (statusData) {
    setText('seat-count', data.count || data.seats.length);
    setText('seat-max', statusData.maxSeats);
  }

  const rows = data.seats.map(s => {
    const hbClass = heartbeatClass(s.last_heartbeat);
    return `<tr>
      <td>
        <span class="heartbeat ${hbClass}"></span>
        <span class="addr" style="margin-left:0.5rem">${truncateAddress(s.agent_address || s.address)}</span>
      </td>
      <td>${escapeHtml(s.name || '—')}</td>
      <td>${escapeHtml(s.function || s.role || '—')}</td>
      <td>${formatTimestamp(s.term_start)}</td>
      <td>${formatTimestamp(s.term_end)}</td>
      <td>${formatPercent(s.deliberation_count || 0, s.total_proposals || 1)}</td>
      <td>${formatPercent(s.vote_count || 0, s.total_proposals || 1)}</td>
    </tr>`;
  }).join('');

  setHTML('seats-body', rows);
}

// === Utility ===

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// === Auto-refresh ===

function initPage() {
  const page = document.body.dataset.page;

  const loaders = {
    dashboard: loadDashboard,
    forum: loadForum,
    proposals: loadProposals,
    seats: loadSeats,
  };

  const loader = loaders[page];
  if (loader) {
    loader();
    setInterval(loader, REFRESH_INTERVAL);
  }

  // Highlight active nav link
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (a.getAttribute('href') === window.location.pathname ||
        a.getAttribute('href') === './' + window.location.pathname.split('/').pop()) {
      a.classList.add('active');
    }
  });
}

document.addEventListener('DOMContentLoaded', initPage);
