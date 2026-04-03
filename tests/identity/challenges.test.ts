/**
 * Tests for ChallengeManager — stake-based identity challenges, voting, resolution.
 */
import '../helpers/setup';
import { ChallengeManager } from '../../src/identity/challenges';
import { getDb } from '../../src/db/database';

describe('ChallengeManager', () => {
  let manager: ChallengeManager;
  let db: ReturnType<typeof getDb>;

  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    db = getDb();
    // Construct manager first so ensureSchema() creates tables
    manager = new ChallengeManager();
    // Then clean test data
    db.exec('DELETE FROM challenge_votes');
    db.exec('DELETE FROM challenge_details');
    db.exec('DELETE FROM seats');
  });

  function seedSeat(agent: string): void {
    const t = now();
    db.prepare(`
      INSERT OR IGNORE INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
      VALUES (?, ?, ?, ?, ?, '50000000', 'active')
    `).run(agent, `op_${agent}`, `Agent ${agent}`, t - 86400, t + 7776000);
  }

  // --- Create Challenge ---

  describe('createChallenge', () => {
    it('creates a challenge between two seated agents', () => {
      seedSeat('rChallenger');
      seedSeat('rTarget');

      const result = manager.createChallenge({
        challenger: 'rChallenger',
        target: 'rTarget',
        reason: 'Suspicious voting patterns',
        evidenceHash: 'evidence_hash_1',
        txHash: 'tx_challenge_1',
        timestamp: now(),
      });

      expect(result.success).toBe(true);
      expect(result.challengeId).toBeDefined();
    });

    it('rejects challenge from unseated agent', () => {
      seedSeat('rTarget');

      const result = manager.createChallenge({
        challenger: 'rUnseated',
        target: 'rTarget',
        reason: 'test',
        evidenceHash: 'hash',
        txHash: 'tx_1',
        timestamp: now(),
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Challenger does not hold an active seat');
    });

    it('rejects challenge against unseated agent', () => {
      seedSeat('rChallenger');

      const result = manager.createChallenge({
        challenger: 'rChallenger',
        target: 'rUnseated',
        reason: 'test',
        evidenceHash: 'hash',
        txHash: 'tx_1',
        timestamp: now(),
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Target does not hold an active seat');
    });

    it('rejects duplicate active challenge', () => {
      seedSeat('rChallenger');
      seedSeat('rTarget');

      manager.createChallenge({
        challenger: 'rChallenger', target: 'rTarget',
        reason: 'first', evidenceHash: 'h1', txHash: 'tx_1', timestamp: now(),
      });

      const result = manager.createChallenge({
        challenger: 'rChallenger', target: 'rTarget',
        reason: 'second', evidenceHash: 'h2', txHash: 'tx_2', timestamp: now(),
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Active challenge already exists');
    });

    it('sets correct voting window (3 days deliberation + 4 days voting)', () => {
      seedSeat('rChallenger');
      seedSeat('rTarget');
      const t = now();

      const result = manager.createChallenge({
        challenger: 'rChallenger', target: 'rTarget',
        reason: 'test', evidenceHash: 'h1', txHash: 'tx_1', timestamp: t,
      });

      const challenge = manager.getChallenge(result.challengeId!);
      expect(challenge).toBeTruthy();
      expect(challenge!.votingStart).toBe(t + 3 * 86400);
      expect(challenge!.votingEnd).toBe(t + 7 * 86400);
    });
  });

  // --- Cast Challenge Vote ---

  describe('castVote', () => {
    let challengeId: string;
    const challengeTime = () => now() - 4 * 86400; // Created 4 days ago (in voting window)

    beforeEach(() => {
      seedSeat('rChallenger');
      seedSeat('rTarget');
      seedSeat('rVoter1');
      seedSeat('rVoter2');

      const t = challengeTime();
      const result = manager.createChallenge({
        challenger: 'rChallenger', target: 'rTarget',
        reason: 'test', evidenceHash: 'h1', txHash: 'tx_ch', timestamp: t,
      });
      challengeId = result.challengeId!;
    });

    it('accepts a valid vote during voting window', () => {
      const result = manager.castVote({
        challengeId,
        voterAddress: 'rVoter1',
        vote: 'guilty',
        txHash: 'tx_cv_1',
        timestamp: now(),
      });
      expect(result.success).toBe(true);
    });

    it('rejects vote before deliberation ends', () => {
      // Create a fresh challenge (voting hasn't started)
      seedSeat('rC2');
      seedSeat('rT2');
      const freshResult = manager.createChallenge({
        challenger: 'rC2', target: 'rT2',
        reason: 'fresh', evidenceHash: 'h', txHash: 'tx_fresh', timestamp: now(),
      });

      const result = manager.castVote({
        challengeId: freshResult.challengeId!,
        voterAddress: 'rVoter1',
        vote: 'guilty',
        txHash: 'tx_early',
        timestamp: now(), // Before voting_start
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('not started');
    });

    it('rejects vote from unseated agent', () => {
      const result = manager.castVote({
        challengeId,
        voterAddress: 'rUnseated',
        vote: 'guilty',
        txHash: 'tx_unv',
        timestamp: now(),
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('does not hold an active seat');
    });

    it('prevents challenger from voting on own challenge', () => {
      const result = manager.castVote({
        challengeId,
        voterAddress: 'rChallenger',
        vote: 'guilty',
        txHash: 'tx_self',
        timestamp: now(),
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('cannot vote');
    });

    it('prevents target from voting on own challenge', () => {
      const result = manager.castVote({
        challengeId,
        voterAddress: 'rTarget',
        vote: 'innocent',
        txHash: 'tx_target',
        timestamp: now(),
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('cannot vote');
    });

    it('rejects double vote', () => {
      manager.castVote({
        challengeId, voterAddress: 'rVoter1', vote: 'guilty',
        txHash: 'tx_v1', timestamp: now(),
      });

      const result = manager.castVote({
        challengeId, voterAddress: 'rVoter1', vote: 'innocent',
        txHash: 'tx_v2', timestamp: now(),
      });
      expect(result.success).toBe(false);
      expect(result.reason).toContain('already voted');
    });

    it('increments vote tallies', () => {
      manager.castVote({
        challengeId, voterAddress: 'rVoter1', vote: 'guilty',
        txHash: 'tx_v1', timestamp: now(),
      });
      manager.castVote({
        challengeId, voterAddress: 'rVoter2', vote: 'innocent',
        txHash: 'tx_v2', timestamp: now(),
      });

      const c = manager.getChallenge(challengeId)!;
      expect(c.votesGuilty).toBe(1);
      expect(c.votesInnocent).toBe(1);
      expect(c.totalVoters).toBe(2);
    });
  });

  // --- Resolution ---

  describe('resolveExpired', () => {
    function createExpiredChallenge(guiltyVotes: number, innocentVotes: number): string {
      seedSeat('rCh');
      seedSeat('rTgt');

      const t = now() - 10 * 86400; // Created 10 days ago
      const result = manager.createChallenge({
        challenger: 'rCh', target: 'rTgt',
        reason: 'test', evidenceHash: 'h', txHash: `tx_exp_${Math.random()}`, timestamp: t,
      });

      // Add votes directly
      for (let i = 0; i < guiltyVotes; i++) {
        const voter = `rExpVoter${i}`;
        seedSeat(voter);
        db.prepare(`
          INSERT INTO challenge_votes (challenge_id, voter_address, vote, tx_hash, timestamp)
          VALUES (?, ?, 'guilty', ?, ?)
        `).run(result.challengeId, voter, `tx_ev_${voter}`, now() - 5 * 86400);
      }
      for (let i = 0; i < innocentVotes; i++) {
        const voter = `rExpInnVoter${i}`;
        seedSeat(voter);
        db.prepare(`
          INSERT INTO challenge_votes (challenge_id, voter_address, vote, tx_hash, timestamp)
          VALUES (?, ?, 'innocent', ?, ?)
        `).run(result.challengeId, voter, `tx_iv_${voter}`, now() - 5 * 86400);
      }

      // Update tallies
      db.prepare(`
        UPDATE challenge_details SET votes_guilty = ?, votes_innocent = ?, total_voters = ?, status = 'voting'
        WHERE challenge_id = ?
      `).run(guiltyVotes, innocentVotes, guiltyVotes + innocentVotes, result.challengeId);

      return result.challengeId!;
    }

    it('resolves guilty when more guilty votes', () => {
      const cid = createExpiredChallenge(5, 2);
      const results = manager.resolveExpired();
      const r = results.find(r => r.challengeId === cid);
      expect(r).toBeDefined();
      expect(r!.result).toBe('guilty');
    });

    it('resolves innocent when more innocent votes', () => {
      const cid = createExpiredChallenge(2, 5);
      const results = manager.resolveExpired();
      const r = results.find(r => r.challengeId === cid);
      expect(r!.result).toBe('innocent');
    });

    it('expires with insufficient votes', () => {
      const cid = createExpiredChallenge(1, 0); // Only 1 voter, need at least 3
      const results = manager.resolveExpired();
      const r = results.find(r => r.challengeId === cid);
      expect(r!.result).toBe('expired');
    });
  });

  // --- Stake Distribution ---

  describe('getStakeDistribution', () => {
    it('returns challenger refund for expired challenges', () => {
      seedSeat('rCh');
      seedSeat('rTgt');
      const t = now() - 10 * 86400;
      const result = manager.createChallenge({
        challenger: 'rCh', target: 'rTgt',
        reason: 'test', evidenceHash: 'h', txHash: 'tx_sd1', timestamp: t,
      });
      manager.resolveExpired();

      const dist = manager.getStakeDistribution(result.challengeId!);
      expect(dist).toBeTruthy();
      expect(dist!.recipient).toBe('rCh');
    });
  });

  // --- Queries ---

  describe('getActiveChallenges', () => {
    it('returns only open/voting challenges', () => {
      seedSeat('rA');
      seedSeat('rB');
      manager.createChallenge({
        challenger: 'rA', target: 'rB',
        reason: 'test', evidenceHash: 'h', txHash: 'tx_ac', timestamp: now(),
      });

      const active = manager.getActiveChallenges();
      expect(active.length).toBeGreaterThanOrEqual(1);
      expect(active.every(c => ['open', 'voting'].includes(c.status))).toBe(true);
    });
  });

  describe('getChallengesAgainst', () => {
    it('returns challenges targeting a specific agent', () => {
      seedSeat('rA');
      seedSeat('rB');
      manager.createChallenge({
        challenger: 'rA', target: 'rB',
        reason: 'test', evidenceHash: 'h', txHash: 'tx_ca', timestamp: now(),
      });

      const against = manager.getChallengesAgainst('rB');
      expect(against).toHaveLength(1);
      expect(against[0].targetAddress).toBe('rB');
    });
  });
});
