import express from 'express';
import cors from 'cors';
import { config } from '../config';
import { SeatManager } from '../governance/seats';
import { ProposalManager } from '../governance/proposals';
import { getDb } from '../db/database';

export function createServer(seatManager: SeatManager, proposalManager: ProposalManager) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', network: config.xrpl.network, timestamp: Date.now() });
  });

  // === SEATS ===

  app.get('/api/seats', (req, res) => {
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
    const db = getDb();
    const threads = db.prepare(`
      SELECT thread_id, COUNT(*) as post_count, 
             MIN(timestamp) as first_post, MAX(timestamp) as last_post
      FROM forum_posts GROUP BY thread_id ORDER BY last_post DESC
      LIMIT ?
    `).all(parseInt(req.query.limit as string) || 20);
    res.json({ threads });
  });

  app.get('/api/forum/threads/:id', (req, res) => {
    const db = getDb();
    const posts = db.prepare(`
      SELECT * FROM forum_posts WHERE thread_id = ? ORDER BY timestamp ASC
    `).all(req.params.id);
    res.json({ thread_id: req.params.id, posts });
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

  app.get('/api/status', (req, res) => {
    const db = getDb();
    const activeSeats = seatManager.getActiveSeatCount();
    const proposals = {
      deliberation: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'deliberation'`).get() as any).c,
      voting: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'voting'`).get() as any).c,
      passed: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'passed'`).get() as any).c,
      failed: (db.prepare(`SELECT COUNT(*) as c FROM proposals WHERE status = 'failed'`).get() as any).c,
    };
    const stalledExecutions = proposalManager.checkStalledExecutions().length;

    res.json({
      name: 'Sovereign',
      network: config.xrpl.network,
      activeSeats,
      maxSeats: config.governance.maxSeatsInitial,
      proposals,
      stalledExecutions,
      stewardsActive: activeSeats >= config.governance.stewardActivationThreshold,
      arbitersActive: activeSeats >= config.governance.arbiterActivationThreshold,
      timestamp: Date.now(),
    });
  });

  return app;
}
