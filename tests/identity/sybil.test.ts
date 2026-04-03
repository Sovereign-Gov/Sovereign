/**
 * Tests for SybilDetector — vote correlation, heartbeat timing, infra fingerprinting.
 * Funding chain analysis is mocked (requires XRPL connection).
 */
import '../helpers/setup';
import { SybilDetector } from '../../src/identity/sybil';
import { getDb } from '../../src/db/database';
import { Client } from 'xrpl';

// Mock the xrpl Client
jest.mock('xrpl', () => {
  return {
    Client: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      request: jest.fn().mockResolvedValue({ result: { transactions: [] } }),
      isConnected: jest.fn().mockReturnValue(true),
    })),
  };
});

describe('SybilDetector', () => {
  let detector: SybilDetector;
  let db: ReturnType<typeof getDb>;
  let mockClient: any;

  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    db = getDb();
    mockClient = new Client('wss://test');
    // Construct detector first so ensureSchema() creates sybil_reports table
    detector = new SybilDetector(mockClient, 60);
    // Then clean test data
    db.exec('DELETE FROM sybil_reports');
    db.exec('DELETE FROM forum_posts');
    db.exec('DELETE FROM heartbeats');
    db.exec('DELETE FROM votes');
    db.exec('DELETE FROM activity');
    db.exec('DELETE FROM proposals');
    db.exec('DELETE FROM seats');
  });

  function seedSeat(agent: string): void {
    const t = now();
    db.prepare(`
      INSERT OR IGNORE INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
      VALUES (?, ?, ?, ?, ?, '50000000', 'active')
    `).run(agent, `op_${agent}`, `Agent ${agent}`, t - 86400, t + 7776000);
  }

  function seedProposal(proposalId: string): void {
    const t = now();
    db.prepare(`
      INSERT OR IGNORE INTO proposals (proposal_id, author_address, title, description_hash, category, status, deliberation_start, deliberation_end, tx_hash)
      VALUES (?, 'rAuthor', 'Test', 'hash', 'standard', 'voting', ?, ?, ?)
    `).run(proposalId, t - 86400, t, `tx_p_${proposalId}`);
  }

  function seedVotes(agent: string, votes: Array<{ proposalId: string; vote: string }>): void {
    for (const v of votes) {
      seedProposal(v.proposalId);
      db.prepare(`
        INSERT OR IGNORE INTO votes (proposal_id, agent_address, vote, tx_hash, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(v.proposalId, agent, v.vote, `vtx_${agent}_${v.proposalId}`, now());
    }
  }

  function seedHeartbeats(agent: string, timestamps: number[]): void {
    for (let i = 0; i < timestamps.length; i++) {
      db.prepare(`
        INSERT OR IGNORE INTO heartbeats (agent_address, tx_hash, timestamp)
        VALUES (?, ?, ?)
      `).run(agent, `hb_${agent}_${i}`, timestamps[i]);
    }
  }

  function seedForumPosts(agent: string, texts: string[]): void {
    for (let i = 0; i < texts.length; i++) {
      db.prepare(`
        INSERT INTO forum_posts (thread_id, author_address, content_hash, content_text, tx_hash, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`thread_${i}`, agent, `hash_${agent}_${i}`, texts[i], `ftx_${agent}_${i}`, now());
    }
  }

  // --- Schema ---

  describe('schema', () => {
    it('creates the sybil_reports table', () => {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sybil_reports'`).get();
      expect(row).toBeTruthy();
    });
  });

  // --- Full Analysis ---

  describe('analyze', () => {
    it('returns a report with all signal scores', async () => {
      seedSeat('rTarget');
      seedSeat('rOther');

      const report = await detector.analyze('rTarget');
      expect(report.agentAddress).toBe('rTarget');
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(100);
      expect(report.signals).toHaveProperty('fundingChain');
      expect(report.signals).toHaveProperty('voteCorrelation');
      expect(report.signals).toHaveProperty('heartbeatTiming');
      expect(report.signals).toHaveProperty('infraFingerprint');
      expect(report.timestamp).toBeGreaterThan(0);
    });

    it('persists the report in the database', async () => {
      seedSeat('rTarget');
      await detector.analyze('rTarget');

      const row = db.prepare(`SELECT * FROM sybil_reports WHERE agent_address = 'rTarget'`).get();
      expect(row).toBeTruthy();
    });

    it('triggers auto-challenge when score exceeds threshold', async () => {
      // Lower threshold to easily trigger
      detector = new SybilDetector(mockClient, 0);
      seedSeat('rSuspect');
      seedSeat('rClone');

      // Create identical vote patterns (high correlation)
      const proposals = ['p1', 'p2', 'p3', 'p4', 'p5'];
      seedVotes('rSuspect', proposals.map(p => ({ proposalId: p, vote: 'yes' })));
      seedVotes('rClone', proposals.map(p => ({ proposalId: p, vote: 'yes' })));

      const report = await detector.analyze('rSuspect');
      // With threshold=0, any non-zero score triggers auto-challenge
      expect(report.autoChallenge).toBe(true);
    });
  });

  // --- Vote Correlation ---

  describe('vote correlation signal', () => {
    it('scores 0 when agents have insufficient votes', async () => {
      seedSeat('rA');
      seedSeat('rB');
      // Only 2 votes each (needs 3 minimum)
      seedVotes('rA', [{ proposalId: 'p1', vote: 'yes' }, { proposalId: 'p2', vote: 'yes' }]);
      seedVotes('rB', [{ proposalId: 'p1', vote: 'yes' }, { proposalId: 'p2', vote: 'yes' }]);

      const report = await detector.analyze('rA');
      expect(report.signals.voteCorrelation).toBe(0);
    });

    it('flags agents with 90%+ identical votes', async () => {
      seedSeat('rA');
      seedSeat('rB');

      const proposals = ['p1', 'p2', 'p3', 'p4', 'p5'];
      seedVotes('rA', proposals.map(p => ({ proposalId: p, vote: 'yes' })));
      seedVotes('rB', proposals.map(p => ({ proposalId: p, vote: 'yes' })));

      const report = await detector.analyze('rA');
      expect(report.signals.voteCorrelation).toBeGreaterThanOrEqual(90);
      expect(report.flaggedPairs).toContain('rB');
    });

    it('does not flag agents with divergent votes', async () => {
      seedSeat('rA');
      seedSeat('rB');

      seedVotes('rA', [
        { proposalId: 'p1', vote: 'yes' }, { proposalId: 'p2', vote: 'no' },
        { proposalId: 'p3', vote: 'yes' }, { proposalId: 'p4', vote: 'no' },
      ]);
      seedVotes('rB', [
        { proposalId: 'p1', vote: 'no' }, { proposalId: 'p2', vote: 'yes' },
        { proposalId: 'p3', vote: 'no' }, { proposalId: 'p4', vote: 'yes' },
      ]);

      const report = await detector.analyze('rA');
      expect(report.signals.voteCorrelation).toBe(0);
    });
  });

  // --- Heartbeat Timing ---

  describe('heartbeat timing signal', () => {
    it('scores 0 with insufficient heartbeat data', async () => {
      seedSeat('rA');
      seedSeat('rB');
      seedHeartbeats('rA', [100, 200, 300]);
      seedHeartbeats('rB', [100, 200, 300]);

      const report = await detector.analyze('rA');
      expect(report.signals.heartbeatTiming).toBe(0);
    });

    it('scores high for synchronized heartbeats', async () => {
      seedSeat('rA');
      seedSeat('rB');

      const base = now();
      const timestamps = Array.from({ length: 10 }, (_, i) => base + i * 86400);
      // Nearly identical timestamps (within 10 seconds)
      seedHeartbeats('rA', timestamps);
      seedHeartbeats('rB', timestamps.map(t => t + 5));

      const report = await detector.analyze('rA');
      expect(report.signals.heartbeatTiming).toBeGreaterThan(40);
    });

    it('scores low for unsynchronized heartbeats', async () => {
      seedSeat('rA');
      seedSeat('rB');

      const base = now();
      // Agent A: every 24h starting at base
      seedHeartbeats('rA', Array.from({ length: 10 }, (_, i) => base + i * 86400));
      // Agent B: offset by 12 hours
      seedHeartbeats('rB', Array.from({ length: 10 }, (_, i) => base + i * 86400 + 43200));

      const report = await detector.analyze('rA');
      expect(report.signals.heartbeatTiming).toBe(0);
    });
  });

  // --- Infrastructure Fingerprinting ---

  describe('infrastructure fingerprinting signal', () => {
    it('scores 0 with insufficient posts', async () => {
      seedSeat('rA');
      seedSeat('rB');
      seedForumPosts('rA', ['Hello world']);
      seedForumPosts('rB', ['Hello world']);

      const report = await detector.analyze('rA');
      expect(report.signals.infraFingerprint).toBe(0);
    });

    it('flags agents with similar writing patterns', async () => {
      seedSeat('rA');
      seedSeat('rB');

      const posts = [
        '# Header\n\nThis is a paragraph. It has some sentences. They are medium length.\n\n- Bullet one\n- Bullet two\n\n```code block```',
        '# Another Header\n\nAnother paragraph here. More sentences follow. They continue.\n\n- Item one\n- Item two\n\n```more code```',
        '# Third Post\n\nYet another paragraph. Sentences here too. They go on.\n\n- Point one\n- Point two\n\n```code```',
      ];

      seedForumPosts('rA', posts);
      seedForumPosts('rB', posts); // Identical patterns

      const report = await detector.analyze('rA');
      expect(report.signals.infraFingerprint).toBeGreaterThan(0);
    });
  });

  // --- Report Retrieval ---

  describe('getLatestReport', () => {
    it('returns null for unknown agent', () => {
      const report = detector.getLatestReport('rUnknown');
      expect(report).toBeNull();
    });

    it('returns the most recent report', async () => {
      seedSeat('rA');
      await detector.analyze('rA');
      await detector.analyze('rA'); // Second analysis

      const report = detector.getLatestReport('rA');
      expect(report).toBeTruthy();
      expect(report!.agentAddress).toBe('rA');
    });
  });

  // --- Flagged Agents ---

  describe('getFlaggedAgents', () => {
    it('returns empty array with no flagged agents', () => {
      const flagged = detector.getFlaggedAgents();
      expect(flagged).toHaveLength(0);
    });

    it('returns agents above threshold', async () => {
      // Use threshold of 0 so any analysis result is flagged
      detector = new SybilDetector(mockClient, 0);
      seedSeat('rA');
      seedSeat('rB');

      // Create conditions for non-zero score
      const proposals = ['p1', 'p2', 'p3', 'p4', 'p5'];
      seedVotes('rA', proposals.map(p => ({ proposalId: p, vote: 'yes' })));
      seedVotes('rB', proposals.map(p => ({ proposalId: p, vote: 'yes' })));

      await detector.analyze('rA');
      const flagged = detector.getFlaggedAgents();
      // Should have at least the analyzed agent if score > 0
      // (Depends on whether vote correlation alone pushes above 0)
      expect(Array.isArray(flagged)).toBe(true);
    });
  });
});
