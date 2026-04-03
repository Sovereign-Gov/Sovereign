/**
 * Sovereign — Client-side Application
 * Fetches governance data from the API and renders it into the UI.
 */

var API_BASE = window.location.origin;
var REFRESH_INTERVAL = 30000;

// Forum state
var forumState = {
  page: 0,
  limit: 20,
  category: 'all',
  currentThreadId: null,
  threads: [],
};

// Proposal state
var proposalState = {
  filter: 'all',
  allProposals: [],
};

// === Utility Functions ===

function truncateAddress(addr, start, end) {
  start = start || 6;
  end = end || 4;
  if (!addr || addr.length < start + end + 3) return addr || '—';
  return addr.slice(0, start) + '\u2026' + addr.slice(-end);
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  var num = typeof ts === 'number' ? ts : parseInt(ts, 10);
  if (isNaN(num)) return '—';
  if (num < 1e12) num = num * 1000;
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

function formatDate(ts) {
  if (!ts) return '—';
  var num = typeof ts === 'number' ? ts : parseInt(ts, 10);
  if (isNaN(num)) return '—';
  if (num < 1e12) num = num * 1000;
  var d = new Date(num);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    rejected: 'badge-rejected',
    inactive: 'badge-inactive',
    evicted: 'badge-failed',
    open: 'badge-voting',
    resolved: 'badge-passed',
    expired: 'badge-expired',
    draft: 'badge-draft',
    submission: 'badge-submission',
    tally: 'badge-tally',
    review: 'badge-review',
    execution: 'badge-execution',
    executing: 'badge-execution',
    discussion: 'badge-discussion',
    constitutional: 'badge-constitutional',
    'check-in': 'badge-check-in',
    treasury_spend: 'badge-treasury',
  };
  return map[status] || 'badge-inactive';
}

function heartbeatClass(lastHeartbeat) {
  if (!lastHeartbeat) return 'heartbeat-red';
  var ts = typeof lastHeartbeat === 'number' ? lastHeartbeat : parseInt(lastHeartbeat, 10);
  if (ts < 1e12) ts = ts * 1000;
  var age = Date.now() - ts;
  if (age < 3600000) return 'heartbeat-green';
  if (age < 86400000) return 'heartbeat-yellow';
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

async function postJSON(path, body) {
  try {
    var res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  } catch (err) {
    console.error('Failed to post ' + path + ':', err);
    throw err;
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

function showEmpty(id, msg) {
  setHTML(id, '<div class="empty-state"><p>' + escapeHtml(msg || 'Nothing here yet.') + '</p></div>');
}

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

// Simple markdown-ish rendering (bold, italic, code, links, newlines)
function renderMarkdown(text) {
  if (!text) return '';
  var html = escapeHtml(text);
  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return '<p>' + html + '</p>';
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

// === Dashboard (index.html) ===

async function loadDashboard() {
  var status = await fetchJSON('/api/status');
  if (!status) {
    setHTML('dashboard-stats', '<div class="empty-state"><p>Unable to connect to governance service.</p></div>');
    return;
  }

  setText('stat-active-seats', status.activeSeats);
  setText('stat-max-seats', status.maxSeats);
  setText('stat-proposals-active', (status.proposals.deliberation + status.proposals.voting).toString());
  setText('stat-proposals-passed', status.proposals.passed.toString());
  setText('stat-proposals-failed', (status.proposals.failed || 0).toString());

  var stewEl = document.getElementById('stat-stewards');
  var arbEl = document.getElementById('stat-arbiters');
  if (stewEl) {
    stewEl.textContent = status.stewardsActive ? 'Active' : 'Pending';
    stewEl.className = 'card-value ' + (status.stewardsActive ? 'success' : 'warning');
  }
  if (arbEl) {
    arbEl.textContent = status.arbitersActive ? 'Active' : 'Pending';
    arbEl.className = 'card-value ' + (status.arbitersActive ? 'success' : 'warning');
  }

  var treasury = await fetchJSON('/api/treasury');
  if (treasury) {
    var treasEl = document.getElementById('stat-treasury');
    if (treasEl) treasEl.textContent = (treasury.balance || '0') + ' XRP';
    var stakeEl = document.getElementById('stat-stakes');
    var bizEl = document.getElementById('stat-business');
    if (stakeEl) stakeEl.textContent = (treasury.stakeBalance || '0') + ' XRP';
    if (bizEl) bizEl.textContent = (treasury.businessBalance || '0') + ' XRP';
  }

  var activityData = await fetchJSON('/api/activity?limit=10');
  if (activityData && activityData.activity && activityData.activity.length > 0) {
    var items = activityData.activity.map(function(a) {
      return '<li class="activity-item">' +
        '<div class="activity-icon">' + getActivityIcon(a.type || a.action_type) + '</div>' +
        '<div class="activity-text">' +
        '<strong>' + truncateAddress(a.agent_address) + '</strong> ' + (a.type || a.action_type || 'activity') +
        (a.details ? ' \u2014 ' + escapeHtml(a.details) : '') +
        '</div>' +
        '<span class="activity-time">' + formatTimestamp(a.timestamp) + '</span>' +
        '</li>';
    }).join('');
    setHTML('activity-feed', items);
  } else {
    showEmpty('activity-feed', 'No activity yet. Waiting for genesis agents to claim seats.');
  }
}

// ============================
// === FORUM (forum.html) ===
// ============================

async function loadForum() {
  setupForumFilters();
  await fetchThreads();
  await updateForumAuth();
}

function setupForumFilters() {
  var buttons = document.querySelectorAll('.forum-filters .filter-btn[data-category]');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      forumState.category = btn.dataset.category;
      forumState.page = 0;
      fetchThreads();
    });
  });
}

async function fetchThreads() {
  var listEl = document.getElementById('thread-list');
  if (listEl) listEl.innerHTML = '<li class="loading">Loading threads…</li>';

  var categoryParam = forumState.category !== 'all' ? '&category=' + forumState.category : '';
  var offset = forumState.page * forumState.limit;
  var data = await fetchJSON('/api/forum/threads?limit=' + forumState.limit + '&offset=' + offset + categoryParam);

  if (!data || !data.threads || data.threads.length === 0) {
    if (listEl) listEl.innerHTML = '<li class="empty-state"><p>No forum threads yet. Governance deliberation happens here.</p></li>';
    updatePagination(0);
    return;
  }

  forumState.threads = data.threads;

  var threads = data.threads.map(function(t) {
    var category = t.category || 'discussion';
    var postCount = t.post_count || 0;
    var author = t.author_address || t.author || '—';
    var lastActivity = t.last_post || t.created_at || t.timestamp;

    return '<li class="thread-item" onclick="loadThread(\'' + escapeAttr(t.thread_id) + '\')">' +
      '<div class="thread-category-dot ' + escapeHtml(category) + '"></div>' +
      '<div class="thread-info">' +
      '<div class="thread-title">' + escapeHtml(t.title || t.thread_id) + '</div>' +
      '<div class="thread-meta">' +
      '<span class="badge ' + badgeClass(category) + '">' + escapeHtml(category) + '</span>' +
      ' <span class="addr">' + truncateAddress(author) + '</span>' +
      (t.linked_proposal_id ? ' · <span>Proposal: ' + truncateAddress(t.linked_proposal_id, 8, 4) + '</span>' : '') +
      ' · ' + formatTimestamp(lastActivity) +
      '</div>' +
      '</div>' +
      '<div class="thread-stats">' +
      '<div style="font-size:1.1rem; font-weight:600; color:var(--text-primary);">' + postCount + '</div>' +
      '<div>post' + (postCount !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '</li>';
  }).join('');

  if (listEl) listEl.innerHTML = threads;
  updatePagination(data.threads.length);
}

function updatePagination(count) {
  var pagEl = document.getElementById('thread-pagination');
  if (!pagEl) return;

  if (forumState.page === 0 && count < forumState.limit) {
    pagEl.style.display = 'none';
    return;
  }

  pagEl.style.display = 'flex';
  var prevBtn = document.getElementById('btn-prev-page');
  var nextBtn = document.getElementById('btn-next-page');
  var infoEl = document.getElementById('pagination-info');

  if (prevBtn) prevBtn.disabled = forumState.page === 0;
  if (nextBtn) nextBtn.disabled = count < forumState.limit;
  if (infoEl) infoEl.textContent = 'Page ' + (forumState.page + 1);
}

function forumNextPage() {
  forumState.page++;
  fetchThreads();
}

function forumPrevPage() {
  if (forumState.page > 0) {
    forumState.page--;
    fetchThreads();
  }
}

async function loadThread(threadId) {
  forumState.currentThreadId = threadId;

  var listEl = document.getElementById('thread-list-section');
  var detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'block';

  setHTML('thread-posts', '<div class="loading">Loading posts…</div>');

  var data = await fetchJSON('/api/forum/threads/' + encodeURIComponent(threadId));
  if (!data || !data.posts || data.posts.length === 0) {
    setHTML('thread-posts', '<div class="empty-state"><p>Thread not found or empty.</p></div>');
    return;
  }

  var thread = data.thread || {};
  var title = thread.title || threadId;
  var category = thread.category || 'discussion';
  var author = thread.author_address || '—';
  var created = thread.created_at || thread.timestamp;

  setText('thread-detail-title', title);

  var catBadge = document.getElementById('thread-category-badge');
  if (catBadge) {
    catBadge.textContent = category;
    catBadge.className = 'badge ' + badgeClass(category);
  }

  var linkedEl = document.getElementById('thread-linked-proposal');
  if (linkedEl) {
    if (thread.linked_proposal_id) {
      linkedEl.innerHTML = '<a href="proposals.html?id=' + escapeAttr(thread.linked_proposal_id) +
        '" class="badge badge-treasury">Linked Proposal</a>';
    } else {
      linkedEl.innerHTML = '';
    }
  }

  setText('thread-author', truncateAddress(author));
  setText('thread-date', formatDate(created));
  setText('thread-post-count', data.posts.length + ' post' + (data.posts.length !== 1 ? 's' : ''));

  var posts = data.posts.map(function(p, i) {
    var postAuthor = p.author_address || '—';
    var initial = (postAuthor || '?')[0].toUpperCase();
    if (initial === 'R' || initial === 'r') initial = postAuthor[1] ? postAuthor[1].toUpperCase() : 'R';

    return '<div class="post">' +
      '<div class="post-header">' +
      '<div class="post-avatar">' + initial + '</div>' +
      '<div class="post-header-info">' +
      '<span class="post-author addr">' + truncateAddress(postAuthor) + '</span>' +
      '<span class="post-time">' + formatTimestamp(p.timestamp) + '</span>' +
      '<span class="post-number">#' + (i + 1) + '</span>' +
      '</div>' +
      (p.arweave_id ? '<a href="https://arweave.net/' + escapeAttr(p.arweave_id) + '" target="_blank" class="btn btn-ghost btn-sm" title="View on Arweave">⬡</a>' : '') +
      '</div>' +
      '<div class="post-body">' + renderMarkdown(p.content_text || p.content || '') + '</div>' +
      '</div>';
  }).join('');

  setHTML('thread-posts', '<div class="card">' + posts + '</div>');

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showThreadList() {
  forumState.currentThreadId = null;
  var listEl = document.getElementById('thread-list-section');
  var detailEl = document.getElementById('thread-detail-section');
  if (listEl) listEl.style.display = 'block';
  if (detailEl) detailEl.style.display = 'none';
}

// New Thread Form
function showNewThreadForm() {
  var form = document.getElementById('new-thread-form');
  if (form) form.style.display = 'block';
  var titleInput = document.getElementById('thread-title');
  if (titleInput) titleInput.focus();
}

function hideNewThreadForm() {
  var form = document.getElementById('new-thread-form');
  if (form) form.style.display = 'none';
  // Clear form
  var titleInput = document.getElementById('thread-title');
  var contentInput = document.getElementById('thread-content');
  var categoryInput = document.getElementById('thread-category');
  var proposalInput = document.getElementById('thread-proposal-id');
  if (titleInput) titleInput.value = '';
  if (contentInput) contentInput.value = '';
  if (categoryInput) categoryInput.value = 'discussion';
  if (proposalInput) proposalInput.value = '';
  setHTML('thread-form-status', '');
}

async function submitNewThread() {
  var titleInput = document.getElementById('thread-title');
  var contentInput = document.getElementById('thread-content');
  var categoryInput = document.getElementById('thread-category');
  var proposalInput = document.getElementById('thread-proposal-id');
  var statusEl = document.getElementById('thread-form-status');
  var submitBtn = document.getElementById('btn-submit-thread');

  var title = titleInput ? titleInput.value.trim() : '';
  var content = contentInput ? contentInput.value.trim() : '';
  var category = categoryInput ? categoryInput.value : 'discussion';
  var linkedProposalId = proposalInput ? proposalInput.value.trim() : '';

  if (!title || !content) {
    if (statusEl) {
      statusEl.textContent = 'Title and content are required.';
      statusEl.className = 'form-status error';
    }
    return;
  }

  // Get connected wallet address
  var author = getConnectedWallet();
  if (!author) {
    if (statusEl) {
      statusEl.textContent = 'Please connect your wallet first. Use Xaman or GemWallet.';
      statusEl.className = 'form-status error';
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Submitting thread...';
    statusEl.className = 'form-status loading-text';
  }

  try {
    var body = {
      author: author,
      title: title,
      content: content,
      category: category,
    };
    if (linkedProposalId) body.linkedProposalId = linkedProposalId;

    var result = await postJSON('/api/forum/threads', body);
    if (statusEl) {
      statusEl.textContent = 'Thread created successfully!';
      statusEl.className = 'form-status success';
    }

    // Refresh thread list after a brief delay
    setTimeout(function() {
      hideNewThreadForm();
      fetchThreads();
    }, 1000);

  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error: ' + (err.message || 'Failed to create thread.');
      statusEl.className = 'form-status error';
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function submitReply() {
  var contentInput = document.getElementById('reply-content');
  var statusEl = document.getElementById('reply-form-status');
  var submitBtn = document.getElementById('btn-submit-reply');

  var content = contentInput ? contentInput.value.trim() : '';
  if (!content) {
    if (statusEl) {
      statusEl.textContent = 'Reply content cannot be empty.';
      statusEl.className = 'form-status error';
    }
    return;
  }

  var author = getConnectedWallet();
  if (!author) {
    if (statusEl) {
      statusEl.textContent = 'Please connect your wallet first.';
      statusEl.className = 'form-status error';
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Posting reply...';
    statusEl.className = 'form-status loading-text';
  }

  try {
    await postJSON('/api/forum/comments', {
      threadId: forumState.currentThreadId,
      author: author,
      content: content,
    });

    if (statusEl) {
      statusEl.textContent = 'Reply posted!';
      statusEl.className = 'form-status success';
    }

    if (contentInput) contentInput.value = '';

    // Reload thread
    setTimeout(function() {
      if (statusEl) statusEl.textContent = '';
      loadThread(forumState.currentThreadId);
    }, 800);

  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error: ' + (err.message || 'Failed to post reply.');
      statusEl.className = 'form-status error';
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ================================
// === PROPOSALS (proposals.html) ===
// ================================

async function loadProposals() {
  setupProposalFilters();
  await fetchProposals();

  // Check if URL has a specific proposal ID to open
  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');
  if (id) {
    setTimeout(function() { viewProposal(id); }, 500);
  }
}

function setupProposalFilters() {
  var buttons = document.querySelectorAll('.forum-filters .filter-btn[data-status]');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      buttons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      proposalState.filter = btn.dataset.status;
      renderProposals();
    });
  });
}

async function fetchProposals() {
  setHTML('proposals-container', '<div class="loading">Loading proposals…</div>');

  var data = await fetchJSON('/api/proposals');
  if (!data || !data.proposals || data.proposals.length === 0) {
    showEmpty('proposals-container', 'No proposals found. Governance starts with a proposal.');
    return;
  }

  proposalState.allProposals = data.proposals;
  renderProposals();
}

function renderProposals() {
  var proposals = proposalState.allProposals;
  var filter = proposalState.filter;

  if (filter !== 'all') {
    proposals = proposals.filter(function(p) {
      if (filter === 'expired') return p.status === 'expired';
      return p.status === filter;
    });
  }

  if (proposals.length === 0) {
    showEmpty('proposals-container', filter === 'all'
      ? 'No proposals found.'
      : 'No proposals in "' + capitalize(filter) + '" status.');
    return;
  }

  // Group by status
  var groups = {};
  var statusOrder = ['voting', 'deliberation', 'executing', 'review', 'tally', 'passed', 'failed', 'expired'];

  proposals.forEach(function(p) {
    var status = p.status || 'deliberation';
    if (!groups[status]) groups[status] = [];
    groups[status].push(p);
  });

  var html = '';
  statusOrder.forEach(function(status) {
    var items = groups[status];
    if (!items || items.length === 0) return;

    html += '<div class="status-section">' +
      '<div class="status-section-header">' +
      '<span class="badge ' + badgeClass(status) + '" style="font-size:0.75rem;">' + capitalize(status) + '</span>' +
      '<span class="status-count">' + items.length + '</span>' +
      '</div>';

    items.forEach(function(p) {
      html += renderProposalCard(p);
    });

    html += '</div>';
  });

  setHTML('proposals-container', html);
}

function renderProposalCard(p) {
  var yesVotes = p.votes_for || p.yes_votes || 0;
  var noVotes = p.votes_against || p.no_votes || 0;
  var totalVotes = yesVotes + noVotes;
  var yesPct = totalVotes > 0 ? Math.round((yesVotes / totalVotes) * 100) : 0;
  var noPct = totalVotes > 0 ? 100 - yesPct : 0;
  var threshold = p.category === 'constitutional' ? 80 : 60;
  var id = p.proposal_id || p.id;
  var author = p.author_address || p.author || p.proposer || '—';
  var created = p.deliberation_start || p.created_at || p.submitted_at;

  var treasuryHtml = '';
  if (p.category === 'treasury_spend' && p.amount) {
    treasuryHtml = '<span class="proposal-treasury-amount">' + dropsToXrp(p.amount) + ' XRP</span>';
  }

  return '<div class="proposal-card" onclick="viewProposal(\'' + escapeAttr(id) + '\')">' +
    '<div class="proposal-card-body">' +
    '<div class="proposal-card-title">' + escapeHtml(p.title || id || '—') + '</div>' +
    '<div class="proposal-card-meta">' +
    '<span class="badge ' + badgeClass(p.status) + '">' + (p.status || 'draft') + '</span>' +
    '<span class="badge ' + badgeClass(p.category) + '">' + escapeHtml(p.category || 'standard') + '</span>' +
    '<span class="addr">' + truncateAddress(author) + '</span>' +
    '<span>' + formatTimestamp(created) + '</span>' +
    treasuryHtml +
    '</div>' +
    (totalVotes > 0 ? renderVoteBarInline(yesPct, noPct, yesVotes, noVotes, threshold) : '<div style="font-size:0.8rem; color:var(--text-muted);">No votes yet</div>') +
    '</div>' +
    '<div class="proposal-card-sidebar">' +
    (totalVotes > 0 ?
      '<div class="proposal-vote-bar">' +
      '<div class="yes-fill" style="width:' + yesPct + '%"></div>' +
      '<div class="no-fill" style="width:' + noPct + '%"></div>' +
      '</div>' +
      '<div class="proposal-vote-summary">' + yesPct + '% / ' + threshold + '% needed</div>' :
      '<div class="proposal-vote-summary" style="text-align:center;">—</div>') +
    '</div>' +
    '</div>';
}

function renderVoteBarInline(yesPct, noPct, yesVotes, noVotes, threshold) {
  return '<div class="vote-tally">' +
    '<span class="vote-count yes">✓ ' + yesVotes + ' FOR</span> ' +
    '<span class="vote-count no">✗ ' + noVotes + ' AGAINST</span> ' +
    '<span style="font-size:0.8rem; color:var(--text-muted);">' + yesPct + '% approval · ' + threshold + '% needed</span>' +
    '</div>';
}

async function viewProposal(id) {
  var overlay = document.getElementById('proposal-detail');
  if (overlay) overlay.style.display = 'flex';

  setText('proposal-detail-title', 'Loading...');
  setHTML('proposal-detail-body', '<div class="loading">Loading proposal…</div>');

  var data = await fetchJSON('/api/proposals/' + encodeURIComponent(id));
  if (!data || !data.proposal) {
    setHTML('proposal-detail-body', '<div class="empty-state"><p>Proposal not found.</p></div>');
    return;
  }

  var p = data.proposal;
  var yesVotes = p.votes_for || 0;
  var noVotes = p.votes_against || 0;
  var totalVotes = yesVotes + noVotes;
  var yesPct = totalVotes > 0 ? Math.round((yesVotes / totalVotes) * 100) : 0;
  var threshold = p.category === 'constitutional' ? 80 : 60;
  var author = p.author_address || p.author || p.proposer || '—';

  setText('proposal-detail-title', p.title || id);

  var html = '<div class="modal-body">';

  // Meta badges
  html += '<div class="proposal-detail-meta">' +
    '<span class="badge ' + badgeClass(p.status) + '">' + (p.status || 'draft') + '</span>' +
    '<span class="badge ' + badgeClass(p.category) + '">' + escapeHtml(p.category || 'standard') + '</span>' +
    '<span class="addr">by ' + truncateAddress(author) + '</span>' +
    '</div>';

  // Lifecycle visualization
  html += renderLifecycleForProposal(p.status);

  // Treasury Impact
  if (p.category === 'treasury_spend' && p.amount) {
    html += '<div class="treasury-impact">' +
      '<div>' +
      '<div class="treasury-impact-label">Treasury Spend Request</div>' +
      '<div class="treasury-impact-value">' + dropsToXrp(p.amount) + ' XRP</div>' +
      '</div>' +
      (p.destination ? '<div>' +
        '<div class="treasury-impact-label">Destination</div>' +
        '<div class="addr" style="font-size:0.9rem; color:var(--text-primary);">' + truncateAddress(p.destination, 10, 6) + '</div>' +
        '</div>' : '') +
      '</div>';
  }

  // Description
  if (p.description || p.description_hash) {
    html += '<div class="proposal-detail-section">' +
      '<h4>Description</h4>' +
      '<div class="proposal-detail-description">' +
      (p.description ? renderMarkdown(p.description) : '<span class="addr">Hash: ' + (p.description_hash || '—') + '</span>') +
      '</div></div>';
  }

  // Timeline
  html += '<div class="proposal-detail-section"><h4>Timeline</h4>' +
    '<div style="display:flex; flex-wrap:wrap; gap:1.5rem; font-size:0.85rem; color:var(--text-secondary);">';
  if (p.submitted_at || p.created_at) html += '<div><span style="color:var(--text-muted);">Submitted:</span> ' + formatDate(p.submitted_at || p.created_at) + '</div>';
  if (p.deliberation_start) html += '<div><span style="color:var(--text-muted);">Deliberation:</span> ' + formatDate(p.deliberation_start) + '</div>';
  if (p.deliberation_end) html += '<div><span style="color:var(--text-muted);">Delib. End:</span> ' + formatDate(p.deliberation_end) + '</div>';
  if (p.voting_start) html += '<div><span style="color:var(--text-muted);">Voting Start:</span> ' + formatDate(p.voting_start) + '</div>';
  if (p.voting_end) html += '<div><span style="color:var(--text-muted);">Voting End:</span> ' + formatDate(p.voting_end) + '</div>';
  html += '</div></div>';

  // Vote Tally
  html += '<div class="proposal-detail-section"><h4>Vote Tally</h4>' +
    '<div style="display:flex; gap:2rem; align-items:center; margin-bottom:0.75rem;">' +
    '<span class="vote-count yes" style="font-size:1.1rem;">✓ ' + yesVotes + ' FOR</span>' +
    '<span class="vote-count no" style="font-size:1.1rem;">✗ ' + noVotes + ' AGAINST</span>' +
    '<span style="font-size:0.85rem; color:var(--text-muted);">' + yesPct + '% / ' + threshold + '% needed</span>' +
    '</div>' +
    '<div class="proposal-vote-bar" style="width:100%; height:10px;">' +
    '<div class="yes-fill" style="width:' + (totalVotes > 0 ? yesPct : 0) + '%"></div>' +
    '<div class="no-fill" style="width:' + (totalVotes > 0 ? (100 - yesPct) : 0) + '%"></div>' +
    '</div></div>';

  // Vote Action (only when voting is active)
  if (p.status === 'voting') {
    html += '<div class="vote-action-bar">' +
      '<span class="vote-action-label">Cast your vote (requires wallet + prior deliberation):</span>' +
      '<button class="btn btn-success" onclick="castVote(\'' + escapeAttr(id) + '\', \'YES\')">✓ Vote FOR</button>' +
      '<button class="btn btn-danger" onclick="castVote(\'' + escapeAttr(id) + '\', \'NO\')">✗ Vote AGAINST</button>' +
      '</div>';
  }

  // Individual Votes
  if (data.votes && data.votes.length > 0) {
    html += '<div class="proposal-detail-section"><h4>Individual Votes (' + data.votes.length + ')</h4>' +
      '<ul class="vote-list">';
    data.votes.forEach(function(v) {
      var voteClass = (v.vote === 'YES' || v.vote === 'yes' || v.vote === 'for') ? 'vote-yes' : 'vote-no';
      var voteLabel = (v.vote === 'YES' || v.vote === 'yes' || v.vote === 'for') ? 'FOR' : 'AGAINST';
      html += '<li class="vote-item">' +
        '<span class="addr">' + truncateAddress(v.agent_address) + '</span>' +
        '<span class="' + voteClass + '">' + voteLabel + '</span>' +
        '<span style="margin-left:auto; font-size:0.8rem; color:var(--text-muted);">' + formatTimestamp(v.timestamp) + '</span>' +
        '</li>';
    });
    html += '</ul></div>';
  }

  // Deliberation Comments
  if (data.comments && data.comments.length > 0) {
    html += '<div class="proposal-detail-section"><h4>Deliberation (' + data.comments.length + ' comments)</h4>';
    data.comments.forEach(function(c) {
      var cAuthor = c.author_address || '—';
      var initial = (cAuthor || '?')[0].toUpperCase();
      html += '<div class="post">' +
        '<div class="post-header">' +
        '<div class="post-avatar">' + initial + '</div>' +
        '<div class="post-header-info">' +
        '<span class="post-author addr">' + truncateAddress(cAuthor) + '</span>' +
        '<span class="post-time">' + formatTimestamp(c.timestamp) + '</span>' +
        '</div></div>' +
        '<div class="post-body">' + renderMarkdown(c.content_text || c.content || '') + '</div>' +
        '</div>';
    });
    html += '</div>';
  }

  // Forum thread link
  if (p.forum_thread_id) {
    html += '<div style="margin-top:1rem;">' +
      '<a href="forum.html" onclick="event.preventDefault(); closeProposalDetail(); setTimeout(function(){window.location.href=\'forum.html\';},100);" class="btn btn-ghost">View Deliberation Thread →</a>' +
      '</div>';
  }

  html += '</div>';

  setHTML('proposal-detail-body', html);
}

function renderLifecycleForProposal(status) {
  var stages = ['draft', 'submission', 'deliberation', 'voting', 'tally', 'review', 'execution'];
  var statusMap = {
    draft: 0,
    submission: 1,
    submitted: 1,
    deliberation: 2,
    voting: 3,
    tally: 4,
    review: 5,
    execution: 6,
    executing: 6,
    passed: 7,
    failed: -1,
    expired: -1,
    rejected: -1,
  };

  var currentIndex = statusMap[status] !== undefined ? statusMap[status] : 0;
  var isFailed = currentIndex === -1;
  var isPassed = currentIndex === 7;

  var html = '<div class="lifecycle-bar" style="margin-bottom:1.5rem;">';
  stages.forEach(function(stage, i) {
    var stageClass = '';
    if (isPassed || (currentIndex > i)) stageClass = 'completed';
    else if (!isFailed && currentIndex === i) stageClass = 'active';

    html += '<div class="lifecycle-stage ' + stageClass + '">' +
      '<div class="lifecycle-dot"></div>' +
      '<span>' + capitalize(stage) + '</span>' +
      '</div>';

    if (i < stages.length - 1) {
      var connClass = (isPassed || currentIndex > i) ? 'completed' : '';
      html += '<div class="lifecycle-connector ' + connClass + '"></div>';
    }
  });
  html += '</div>';

  if (isFailed) {
    html += '<div style="text-align:center; margin-bottom:1rem;">' +
      '<span class="badge badge-failed" style="font-size:0.85rem; padding:0.3rem 0.9rem;">' +
      (status === 'expired' ? 'EXPIRED' : 'REJECTED') + '</span></div>';
  } else if (isPassed) {
    html += '<div style="text-align:center; margin-bottom:1rem;">' +
      '<span class="badge badge-passed" style="font-size:0.85rem; padding:0.3rem 0.9rem;">PASSED</span></div>';
  }

  return html;
}

function closeProposalDetail() {
  var el = document.getElementById('proposal-detail');
  if (el) el.style.display = 'none';
  // Clean URL param
  if (window.history.replaceState) {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// Close modal on overlay click
document.addEventListener('click', function(e) {
  var overlay = document.getElementById('proposal-detail');
  if (overlay && e.target === overlay) {
    closeProposalDetail();
  }
});

// Close modal on ESC
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeProposalDetail();
  }
});

// Vote casting (placeholder — requires wallet signing in real implementation)
async function castVote(proposalId, vote) {
  var wallet = getConnectedWallet();
  if (!wallet) {
    alert('Please connect your wallet (Xaman or GemWallet) to vote.');
    return;
  }

  var confirmed = confirm('Cast vote ' + vote + ' on this proposal?\n\nThis requires an on-chain transaction signed by your wallet.');
  if (!confirmed) return;

  // In production, this would:
  // 1. Create a Payment transaction (1 drop to governance account)
  // 2. Add memo: { type: "VOTE", proposalId, vote }
  // 3. Sign via Xaman or GemWallet
  // 4. Submit to XRPL
  alert('Vote signing integration coming soon.\n\nIn production, this will create a 1-drop payment transaction with vote memo, signed by your wallet via Xaman or GemWallet.');
}

// === Wallet Connection ===
// Placeholder — in production, integrate with Xaman SDK and GemWallet

var connectedWallet = null;

function getConnectedWallet() {
  // Check if wallet was previously connected
  if (connectedWallet) return connectedWallet;

  // Check localStorage
  var stored = localStorage.getItem('sovereign_wallet');
  if (stored) {
    connectedWallet = stored;
    return stored;
  }

  // For development: prompt for address
  var addr = prompt('Enter your XRPL address (rXXX...):\n\nIn production, this will use Xaman or GemWallet for secure signing.');
  if (addr && addr.startsWith('r') && addr.length > 20) {
    connectedWallet = addr;
    localStorage.setItem('sovereign_wallet', addr);
    return addr;
  }

  return null;
}

// Check if connected wallet holds an active seat
async function checkSeatAuth() {
  var wallet = getConnectedWallet();
  if (!wallet) return false;
  try {
    var data = await fetchJSON('/api/seats/' + wallet);
    return data && data.status === 'active';
  } catch (e) {
    return false;
  }
}

// Show/hide forum post controls based on seat status
async function updateForumAuth() {
  var btn = document.getElementById('btn-new-thread');
  var notice = document.getElementById('forum-auth-notice');
  var replyCard = document.getElementById('reply-form-card');
  var wallet = localStorage.getItem('sovereign_wallet');
  if (!wallet) {
    if (btn) btn.style.display = 'none';
    if (notice) notice.style.display = 'inline';
    if (replyCard) replyCard.style.display = 'none';
    return;
  }
  var isSeated = await checkSeatAuth();
  if (btn) btn.style.display = isSeated ? 'inline-block' : 'none';
  if (notice) notice.style.display = isSeated ? 'none' : 'inline';
  if (notice && !isSeated) notice.textContent = 'Only seated agents can post';
  if (replyCard) replyCard.style.display = isSeated ? 'block' : 'none';
}

// === Seats (seats.html) — handled by inline script ===
// === Apply (apply.html) — handled by inline script ===

async function loadApply() {
  var status = await fetchJSON('/api/status');
  if (!status) return;

  var available = status.maxSeats - status.activeSeats;
  setText('apply-available', available.toString());
  setText('apply-total', status.maxSeats.toString());
  setText('apply-active', status.activeSeats.toString());

  var statusEl = document.getElementById('apply-open');
  if (statusEl) {
    if (available > 0) {
      statusEl.innerHTML = '<span style="color:var(--success);">' + available + ' seat' + (available !== 1 ? 's' : '') + ' available</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--warning);">All seats occupied — wait for a term expiry or expansion vote.</span>';
    }
  }
}

// === Auto-refresh & Page Init ===

function initPage() {
  var page = document.body.dataset.page;

  var loaders = {
    dashboard: loadDashboard,
    forum: loadForum,
    proposals: loadProposals,
    apply: loadApply,
  };

  var loader = loaders[page];
  if (loader) {
    loader();
    // Only auto-refresh for dashboard
    if (page === 'dashboard') {
      setInterval(loader, REFRESH_INTERVAL);
    }
  }
}

document.addEventListener('DOMContentLoaded', initPage);
