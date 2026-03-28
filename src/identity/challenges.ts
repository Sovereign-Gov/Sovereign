import { getDb } from '../db/database';
import { config } from '../config';

/**
 * Challenge system — stake-based identity challenges with council vote resolution.
 *
 * Flow:
 * 1. Challenger stakes 10 XRP and creates challenge against target
 * 2. 7-day resolution window opens
 * 3. Seated agents vote on challenge outcome (guilty/innocent)
 * 4. Result: winner gets loser's stake
 * 5. If guilty: target's seat is revoked
 */

export interface Challenge {
  id: number;
  challengeId: string;
  challengerAddress: string;
  targetAddress: string;
  reason: string;
  evidence: string;       // content hash
  stakeAmount: string;    // drops
  status: 'open' | 'voting' | 'resolved' | 'expired';
  result: 'guilty' | 'innocent' | null;
  votesGuilty: number;
  votesInnocent: number;
  totalVoters: number;
  txHash: string;
  createdAt: number;
  votingStart: number | null;
  votingEnd: number | null;
  resolvedAt: number | null;
}

export interface ChallengeVote {
  challengeId: string;
  voterAddress: string;
  vote: 'guilty' | 'innocent';
  txHash: string;
  timestamp: number;
}

const CHALLENGE_STAKE_DROPS = '10000000'; // 10 XRP
const RESOLUTION_WINDOW_DAYS = 7;
const DELIBERATION_DAYS = 3; // 3 days deliberation, then 4 days voting

export class ChallengeManager {

  constructor() {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS challenge_details (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL UNIQUE,
        challenger_address TEXT NOT NULL,
        target_address TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        stake_amount TEXT NOT NULL DEFAULT '${CHALLENGE_STAKE_DROPS}',
        status TEXT NOT NULL DEFAULT 'open',
        result TEXT,
        votes_guilty INTEGER NOT NULL DEFAULT 0,
        votes_innocent INTEGER NOT NULL DEFAULT 0,
        total_voters INTEGER NOT NULL DEFAULT 0,
        tx_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        voting_start INTEGER,
        voting_end INTEGER,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS challenge_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id TEXT NOT NULL,
        voter_address TEXT NOT NULL,
        vote TEXT NOT NULL CHECK (vote IN ('guilty', 'innocent')),
        tx_hash TEXT NOT NULL UNIQUE,
        timestamp INTEGER NOT NULL,
        UNIQUE(challenge_id, voter_address)
      );

      CREATE INDEX IF NOT EXISTS idx_challenge_status ON challenge_details(status);
      CREATE INDEX IF NOT EXISTS idx_challenge_target ON challenge_details(target_address);
      CREATE INDEX IF NOT EXISTS idx_challenge_votes ON challenge_votes(challenge_id);
    `);
  }

  /**
   * Create a new challenge. Requires 10 XRP stake (verified on-chain).
   */
  createChallenge(params: {
    challenger: string;
    target: string;
    reason: string;
    evidenceHash: string;
    txHash: string;
    timestamp: number;
  }): { success: boolean; challengeId?: string; reason?: string } {
    const db = getDb();

    // Verify challenger holds a seat
    const challengerSeat = db.prepare(`
      SELECT id FROM seats WHERE agent_address = ? AND status = 'active' AND term_end > ?
    `).get(params.challenger, Math.floor(Date.now() / 1000));

    if (!challengerSeat) {
      return { success: false, reason: 'Challenger does not hold an active seat' };
    }

    // Verify target holds a seat
    const targetSeat = db.prepare(`
      SELECT id FROM seats WHERE agent_address = ? AND status = 'active' AND term_end > ?
    `).get(params.target, Math.floor(Date.now() / 1000));

    if (!targetSeat) {
      return { success: false, reason: 'Target does not hold an active seat' };
    }

    // Check no duplicate active challenge
    const existing = db.prepare(`
      SELECT id FROM challenge_details
      WHERE challenger_address = ? AND target_address = ? AND status IN ('open', 'voting')
    `).get(params.challenger, params.target);

    if (existing) {
      return { success: false, reason: 'Active challenge already exists for this pair' };
    }

    const challengeId = `challenge_${params.timestamp}_${Math.random().toString(36).slice(2, 8)}`;
    const votingStart = params.timestamp + (DELIBERATION_DAYS * 86400);
    const votingEnd = params.timestamp + (RESOLUTION_WINDOW_DAYS * 86400);

    db.prepare(`
      INSERT INTO challenge_details (
        challenge_id, challenger_address, target_address, reason, evidence_hash,
        stake_amount, status, tx_hash, created_at, voting_start, voting_end
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(
      challengeId, params.challenger, params.target, params.reason, params.evidenceHash,
      CHALLENGE_STAKE_DROPS, params.txHash, params.timestamp, votingStart, votingEnd
    );

    console.log(`[CHALLENGE] Created ${challengeId}: ${params.challenger} challenges ${params.target}`);
    return { success: true, challengeId };
  }

  /**
   * Cast a vote on a challenge
   */
  castVote(params: ChallengeVote): { success: boolean; reason?: string } {
    const db = getDb();

    // Verify challenge exists and is in voting phase
    const challenge = db.prepare(`
      SELECT * FROM challenge_details WHERE challenge_id = ?
    `).get(params.challengeId) as any;

    if (!challenge) {
      return { success: false, reason: 'Challenge not found' };
    }

    const now = params.timestamp;
    if (now < challenge.voting_start) {
      return { success: false, reason: 'Voting has not started yet (deliberation period)' };
    }
    if (now > challenge.voting_end) {
      return { success: false, reason: 'Voting window has closed' };
    }

    // Verify voter holds a seat
    const voterSeat = db.prepare(`
      SELECT id FROM seats WHERE agent_address = ? AND status = 'active' AND term_end > ?
    `).get(params.voterAddress, now);

    if (!voterSeat) {
      return { success: false, reason: 'Voter does not hold an active seat' };
    }

    // Voter cannot be challenger or target
    if (params.voterAddress === challenge.challenger_address || params.voterAddress === challenge.target_address) {
      return { success: false, reason: 'Challenger and target cannot vote on their own challenge' };
    }

    // Check for duplicate vote
    const existing = db.prepare(`
      SELECT id FROM challenge_votes WHERE challenge_id = ? AND voter_address = ?
    `).get(params.challengeId, params.voterAddress);

    if (existing) {
      return { success: false, reason: 'Agent already voted on this challenge' };
    }

    // Record vote
    db.prepare(`
      INSERT INTO challenge_votes (challenge_id, voter_address, vote, tx_hash, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(params.challengeId, params.voterAddress, params.vote, params.txHash, params.timestamp);

    // Update tallies
    if (params.vote === 'guilty') {
      db.prepare(`UPDATE challenge_details SET votes_guilty = votes_guilty + 1, total_voters = total_voters + 1 WHERE challenge_id = ?`).run(params.challengeId);
    } else {
      db.prepare(`UPDATE challenge_details SET votes_innocent = votes_innocent + 1, total_voters = total_voters + 1 WHERE challenge_id = ?`).run(params.challengeId);
    }

    // Advance to voting status if still open
    if (challenge.status === 'open') {
      db.prepare(`UPDATE challenge_details SET status = 'voting' WHERE challenge_id = ?`).run(params.challengeId);
    }

    console.log(`[CHALLENGE] Vote on ${params.challengeId}: ${params.voterAddress} voted ${params.vote}`);
    return { success: true };
  }

  /**
   * Resolve expired challenges. Returns list of resolved challenges with outcomes.
   */
  resolveExpired(): Array<{ challengeId: string; result: 'guilty' | 'innocent' | 'expired'; targetAddress: string }> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const results: Array<{ challengeId: string; result: 'guilty' | 'innocent' | 'expired'; targetAddress: string }> = [];

    const expired = db.prepare(`
      SELECT * FROM challenge_details WHERE status IN ('open', 'voting') AND voting_end <= ?
    `).all(now) as any[];

    for (const c of expired) {
      const totalVotes = c.votes_guilty + c.votes_innocent;
      const minVoters = Math.max(3, Math.floor(this.getActiveSeatCount() * 0.3)); // At least 30% participation or 3

      let result: 'guilty' | 'innocent' | 'expired';

      if (totalVotes < minVoters) {
        // Not enough votes — challenge expires, stake refunded to challenger
        result = 'expired';
        db.prepare(`
          UPDATE challenge_details SET status = 'expired', result = NULL, resolved_at = ? WHERE challenge_id = ?
        `).run(now, c.challenge_id);
        console.log(`[CHALLENGE] ${c.challenge_id} expired — insufficient votes (${totalVotes}/${minVoters})`);
      } else if (c.votes_guilty > c.votes_innocent) {
        // Guilty — target loses seat, challenger gets target's stake
        result = 'guilty';
        db.prepare(`
          UPDATE challenge_details SET status = 'resolved', result = 'guilty', resolved_at = ? WHERE challenge_id = ?
        `).run(now, c.challenge_id);
        console.log(`[CHALLENGE] ${c.challenge_id} GUILTY — ${c.target_address} seat revoked`);
      } else {
        // Innocent — target keeps seat, target gets challenger's stake
        result = 'innocent';
        db.prepare(`
          UPDATE challenge_details SET status = 'resolved', result = 'innocent', resolved_at = ? WHERE challenge_id = ?
        `).run(now, c.challenge_id);
        console.log(`[CHALLENGE] ${c.challenge_id} INNOCENT — ${c.challenger_address} loses stake`);
      }

      results.push({ challengeId: c.challenge_id, result, targetAddress: c.target_address });
    }

    return results;
  }

  /**
   * Get stake distribution instructions for a resolved challenge.
   * Returns who should receive XRP and how much.
   */
  getStakeDistribution(challengeId: string): {
    recipient: string;
    amount: string;
    reason: string;
  } | null {
    const db = getDb();
    const c = db.prepare(`
      SELECT * FROM challenge_details WHERE challenge_id = ? AND status IN ('resolved', 'expired')
    `).get(challengeId) as any;

    if (!c) return null;

    if (c.status === 'expired') {
      return {
        recipient: c.challenger_address,
        amount: c.stake_amount,
        reason: 'Challenge expired — stake refund',
      };
    }

    if (c.result === 'guilty') {
      return {
        recipient: c.challenger_address,
        amount: String(parseInt(c.stake_amount) * 2), // Challenger gets both stakes
        reason: 'Challenge upheld — target found guilty',
      };
    }

    if (c.result === 'innocent') {
      return {
        recipient: c.target_address,
        amount: String(parseInt(c.stake_amount) * 2), // Target gets both stakes
        reason: 'Challenge rejected — target found innocent',
      };
    }

    return null;
  }

  /**
   * Get a specific challenge
   */
  getChallenge(challengeId: string): Challenge | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM challenge_details WHERE challenge_id = ?`).get(challengeId) as any;
    if (!row) return null;
    return this.rowToChallenge(row);
  }

  /**
   * Get all active challenges
   */
  getActiveChallenges(): Challenge[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM challenge_details WHERE status IN ('open', 'voting') ORDER BY created_at DESC
    `).all() as any[];
    return rows.map(r => this.rowToChallenge(r));
  }

  /**
   * Get challenges targeting a specific agent
   */
  getChallengesAgainst(targetAddress: string): Challenge[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM challenge_details WHERE target_address = ? ORDER BY created_at DESC
    `).all(targetAddress) as any[];
    return rows.map(r => this.rowToChallenge(r));
  }

  // --- Helpers ---

  private rowToChallenge(row: any): Challenge {
    return {
      id: row.id,
      challengeId: row.challenge_id,
      challengerAddress: row.challenger_address,
      targetAddress: row.target_address,
      reason: row.reason,
      evidence: row.evidence_hash,
      stakeAmount: row.stake_amount,
      status: row.status,
      result: row.result,
      votesGuilty: row.votes_guilty,
      votesInnocent: row.votes_innocent,
      totalVoters: row.total_voters,
      txHash: row.tx_hash,
      createdAt: row.created_at,
      votingStart: row.voting_start,
      votingEnd: row.voting_end,
      resolvedAt: row.resolved_at,
    };
  }

  private getActiveSeatCount(): number {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(`SELECT COUNT(*) as count FROM seats WHERE status = 'active' AND term_end > ?`).get(now) as { count: number };
    return row.count;
  }
}
