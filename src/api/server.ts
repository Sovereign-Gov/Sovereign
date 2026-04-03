import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from '../config';
import { SeatManager } from '../governance/seats';
import { ProposalManager } from '../governance/proposals';
import { MultiSignCoordinator } from '../governance/multisign';
import { ForumManager } from '../forum/manager';
import { ForumStorage } from '../forum/storage';
import { KyaManager } from '../identity/kya';
import { SybilDetector } from '../identity/sybil';
import { ChallengeManager } from '../identity/challenges';
import { BadgeManager } from '../governance/badges';
import { XrplWatcher } from '../watchers/xrpl-watcher';
import { getDb } from '../db/database';
import { dropsToXrp } from '../utils/xrpl-helpers';

export function createServer(
  seatManager: SeatManager,
  proposalManager: ProposalManager,
  forumManager: ForumManager,
  forumStorage: ForumStorage,
  kyaManager: KyaManager,
  sybilDetector: SybilDetector,
  challengeManager: ChallengeManager,
  multisignCoordinator: MultiSignCoordinator,
  watcher: XrplWatcher,
  badgeManager?: BadgeManager
) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Serve static web UI
  app.use(express.static(path.join(__dirname, '../../web')));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', network: config.xrpl.network, timestamp: Date.now() });
  });

  // === SEATS ===

  app.get('/api/seats', (_req, res) => {
    const seats = seatManager.getActiveSeats();
    res.json({ seats, count: seats.length });
  });

  app.get('/api/seats/:address', (req, res) => {
    const db = getDb();
    const seat = db.prepare(`SELECT * FROM seats WHERE agent_address = ?`).get(req.params.address);
    if (!seat) return res.status(404).json({ error: 'Seat not found' });

    const stats = seatManager.getParticipationStats(req.params.address);
    res.json({ seat, participation: stats });
  });

  // === PROPOSALS ===

  app.get('/api/proposals', (req, res) => {
    const status = req.query.status as string | undefined;
    const proposals = proposalManager.getProposals(status);
    res.json({ proposals });
  });

  app.get('/api/proposals/:id', (req, res) => {
    const proposal = proposalManager.getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const db = getDb();
    const votes = db.prepare(`SELECT * FROM votes WHERE proposal_id = ?`).all(req.params.id);
    const comments = db.prepare(`
      SELECT * FROM forum_posts WHERE thread_id = ? ORDER BY timestamp ASC
    `).all(req.params.id);

    res.json({ proposal, votes, comments });
  });

  // === FORUM ===

  app.get('/api/forum/threads', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string | undefined;
    const threads = forumManager.listThreads({ limit, offset, category });
    res.json({ threads });
  });

  app.get('/api/forum/threads/:id', (req, res) => {
    const posts = forumManager.getThreadPosts(req.params.id);
    if (posts.length === 0) {
      return res.status(404).json({ error: 'Thread not found or empty' });
    }
    // Get thread metadata
    const db = getDb();
    const thread = db.prepare(`SELECT * FROM forum_threads WHERE thread_id = ?`).get(req.params.id);
    res.json({ thread, posts });
  });

  app.get('/api/forum/posts/:hash', async (req, res) => {
    try {
      const content = await forumStorage.retrieve(req.params.hash);
      if (!content) {
        return res.status(404).json({ error: 'Post content not found' });
      }
      const arweaveId = forumStorage.getArweaveId(req.params.hash);
      res.json({ hash: req.params.hash, content, arweaveId: arweaveId || null });
    } catch (err) {
      res.status(500).json({ error: 'Failed to retrieve content' });
    }
  });

  app.post('/api/forum/threads', async (req, res) => {
    try {
      const { author, title, content, category, linkedProposalId } = req.body;
      if (!author || !title || !content) {
        return res.status(400).json({ error: 'author, title, and content are required' });
      }
      // Only seated agents can post
      const db = getDb();
      const seat = db.prepare("SELECT id FROM seats WHERE agent_address = ? AND status = 'active'").get(author);
      if (!seat) {
        return res.status(403).json({ error: 'Only seated agents can create forum threads' });
      }
      const result = await forumManager.createThread({
        author,
        title,
        content,
        category,
        linkedProposalId,
        txHash: `api_${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
      });
      res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/forum/comments', async (req, res) => {
    try {
      const { threadId, author, content, parentId } = req.body;
      if (!threadId || !author || !content) {
        return res.status(400).json({ error: 'threadId, author, and content are required' });
      }
      // Only seated agents can comment
      const db = getDb();
      const seat = db.prepare("SELECT id FROM seats WHERE agent_address = ? AND status = 'active'").get(author);
      if (!seat) {
        return res.status(403).json({ error: 'Only seated agents can post comments' });
      }
      const result = await forumManager.postComment({
        threadId,
        author,
        content,
        parentId,
        txHash: `api_${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
      });
      res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // === CHALLENGES ===

  app.get('/api/challenges', (_req, res) => {
    const challenges = challengeManager.getActiveChallenges();
    res.json({ challenges });
  });

  app.get('/api/challenges/:id', (req, res) => {
    const challenge = challengeManager.getChallenge(req.params.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const db = getDb();
    const votes = db.prepare(`
      SELECT * FROM challenge_votes WHERE challenge_id = ? ORDER BY timestamp ASC
    `).all(req.params.id);

    const distribution = challengeManager.getStakeDistribution(req.params.id);
    res.json({ challenge, votes, stakeDistribution: distribution });
  });

  // === IDENTITY ===

  app.get('/api/identity/:address', (req, res) => {
    const verification = kyaManager.getVerification(req.params.address);
    const sybilReport = sybilDetector.getLatestReport(req.params.address);
    const challengesAgainst = challengeManager.getChallengesAgainst(req.params.address);

    res.json({
      address: req.params.address,
      kya: verification,
      sybil: sybilReport,
      activeChallenges: challengesAgainst.filter(c => c.status === 'open' || c.status === 'voting'),
    });
  });

  // === TREASURY ===

  app.get('/api/treasury', async (_req, res) => {
    try {
      let balance: string | null = null;
      if (config.xrpl.treasuryAddress) {
        try {
          const balanceDrops = await watcher.getAccountBalance(config.xrpl.treasuryAddress);
          balance = dropsToXrp(balanceDrops);
        } catch {
          balance = null;
        }
      }

      const pending = multisignCoordinator.getPending();
      const db = getDb();
      const submitted = db.prepare(`
        SELECT * FROM multisign_txs WHERE status = 'submitted' ORDER BY created_at DESC LIMIT 10
      `).all();

      let stakeBalance: string | null = null;
      if (config.xrpl.stakeAddress) {
        try {
          stakeBalance = dropsToXrp(await watcher.getAccountBalance(config.xrpl.stakeAddress));
        } catch { stakeBalance = null; }
      }

      let businessBalance: string | null = null;
      if (config.xrpl.businessAddress) {
        try {
          businessBalance = dropsToXrp(await watcher.getAccountBalance(config.xrpl.businessAddress));
        } catch { businessBalance = null; }
      }

      res.json({
        treasuryAddress: config.xrpl.treasuryAddress,
        balance,
        stakeBalance,
        businessBalance,
        pendingTransactions: pending,
        recentSubmissions: submitted,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch treasury data' });
    }
  });

  // === GOVERNANCE / CONSTITUTION ===

  app.get('/api/governance/constitution', (_req, res) => {
    const db = getDb();
    try {
      const constitutional = db.prepare(`
        SELECT * FROM proposals WHERE category = 'constitutional' ORDER BY deliberation_start DESC
      `).all();

      const ratified = constitutional.some((p: any) => p.status === 'passed');

      res.json({
        ratified,
        proposals: constitutional,
        requiredThreshold: config.governance.constitutionalPassThreshold,
        requiredVoters: config.governance.minVotersConstitutional,
      });
    } catch {
      res.json({
        ratified: false,
        proposals: [],
        requiredThreshold: config.governance.constitutionalPassThreshold,
        requiredVoters: config.governance.minVotersConstitutional,
      });
    }
  });

  // === ACTIVITY ===

  app.get('/api/activity', (req, res) => {
    const db = getDb();
    const limit = parseInt(req.query.limit as string) || 50;
    const activity = db.prepare(`
      SELECT * FROM activity ORDER BY timestamp DESC LIMIT ?
    `).all(limit);
    res.json({ activity });
  });

  app.get('/api/activity/:address', (req, res) => {
    const db = getDb();
    const activity = db.prepare(`
      SELECT * FROM activity WHERE agent_address = ? ORDER BY timestamp DESC LIMIT 50
    `).all(req.params.address);
    const heartbeats = db.prepare(`
      SELECT * FROM heartbeats WHERE agent_address = ? ORDER BY timestamp DESC LIMIT 10
    `).all(req.params.address);
    res.json({ activity, heartbeats });
  });

  // === GOVERNANCE STATUS ===

  app.get('/api/status', (_req, res) => {
    const db = getDb();
    const activeSeats = seatManager.getActiveSeatCount();
    const proposals = {
      deliberation: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'deliberation'`).get() as any).c,
      voting: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'voting'`).get() as any).c,
      passed: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'passed'`).get() as any).c,
      failed: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'failed'`).get() as any).c,
    };
    const stalledExecutions = proposalManager.checkStalledExecutions().length;
    const activeChallenges = challengeManager.getActiveChallenges().length;
    const pendingMultisign = multisignCoordinator.getPending().length;

    // Check constitution
    let constitutionRatified = false;
    try {
      const c = db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE category = 'constitutional' AND status = 'passed'`).get() as any;
      constitutionRatified = c.c > 0;
    } catch { /* ignore */ }

    res.json({
      name: 'Sovereign',
      network: config.xrpl.network,
      activeSeats,
      maxSeats: config.governance.maxSeatsInitial,
      proposals,
      stalledExecutions,
      activeChallenges,
      pendingMultisign,
      constitutionRatified,
      stewardsActive: activeSeats >= config.governance.stewardActivationThreshold,
      arbitersActive: activeSeats >= config.governance.arbiterActivationThreshold,
      timestamp: Date.now(),
    });
  });

  // === BADGES ===

  app.get('/api/badges/:address', (req, res) => {
    if (!badgeManager) return res.status(503).json({ error: 'Badge system not initialized' });
    const badges = badgeManager.getAgentBadges(req.params.address);
    res.json({ badges });
  });

  app.get('/api/badges/:address/claimable', (req, res) => {
    if (!badgeManager) return res.status(503).json({ error: 'Badge system not initialized' });
    const badges = badgeManager.getClaimableBadges(req.params.address);
    res.json({ badges });
  });

  app.post('/api/badges/claim', async (req, res) => {
    if (!badgeManager) return res.status(503).json({ error: 'Badge system not initialized' });
    try {
      const { badgeId, txHash } = req.body;
      if (!badgeId || !txHash) {
        return res.status(400).json({ error: 'badgeId and txHash are required' });
      }

      // Look up the badge to get the agent address
      const badge = badgeManager.getBadge(badgeId);
      if (!badge) return res.status(404).json({ error: 'Badge not found' });

      const result = await badgeManager.claimBadge(badge.agent_address, badgeId, txHash);
      res.json({ success: true, nftTokenId: result.nftTokenId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/badges/metadata/:id', (req, res) => {
    if (!badgeManager) return res.status(503).json({ error: 'Badge system not initialized' });
    const badge = badgeManager.getBadge(parseInt(req.params.id, 10));
    if (!badge) return res.status(404).json({ error: 'Badge not found' });
    res.json(JSON.parse(badge.metadata_json));
  });

  // SPA fallback — serve index.html for unmatched routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../web/index.html'));
  });

  return app;
}
