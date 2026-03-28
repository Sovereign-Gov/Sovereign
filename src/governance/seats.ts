import { getDb } from '../db/database';
import { config } from '../config';

export interface SeatInfo {
  id: number;
  agent_address: string;
  operator_id: string;
  name: string;
  function: string;
  goal: string;
  identity_bio: string;
  term_start: number;
  term_end: number;
  stake_amount: string;
  status: string;
}

export interface SeatApplication {
  agent: string;
  operatorId: string;
  name: string;
  function: string;
  goal: string;
  identity: string;
  txHash: string;
  timestamp: number;
}

export class SeatManager {

  /**
   * Get all active seats
   */
  getActiveSeats(): SeatInfo[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM seats WHERE status = 'active' AND term_end > ?
    `).all(Math.floor(Date.now() / 1000)) as SeatInfo[];
  }

  /**
   * Get seat count
   */
  getActiveSeatCount(): number {
    return this.getActiveSeats().length;
  }

  /**
   * Check if an operator already holds a seat
   */
  operatorHasSeat(operatorId: string): boolean {
    const db = getDb();
    const seat = db.prepare(`
      SELECT id FROM seats WHERE operator_id = ? AND status = 'active' AND term_end > ?
    `).get(operatorId, Math.floor(Date.now() / 1000));
    return !!seat;
  }

  /**
   * Check if an agent address already holds a seat
   */
  agentHasSeat(agentAddress: string): boolean {
    const db = getDb();
    const seat = db.prepare(`
      SELECT id FROM seats WHERE agent_address = ? AND status = 'active' AND term_end > ?
    `).get(agentAddress, Math.floor(Date.now() / 1000));
    return !!seat;
  }

  /**
   * Process a seat claim application
   */
  processSeatClaim(app: SeatApplication): { success: boolean; reason?: string } {
    const activeSeats = this.getActiveSeatCount();
    const maxSeats = config.governance.maxSeatsInitial;

    // Check seat capacity
    if (activeSeats >= maxSeats) {
      return { success: false, reason: 'No seats available — maximum capacity reached' };
    }

    // Check operator doesn't already have a seat (one seat per operator)
    if (this.operatorHasSeat(app.operatorId)) {
      return { success: false, reason: 'Operator already holds a seat' };
    }

    // Check agent doesn't already have a seat
    if (this.agentHasSeat(app.agent)) {
      return { success: false, reason: 'Agent already holds a seat' };
    }

    // Calculate term (staggered for genesis)
    const now = Math.floor(Date.now() / 1000);
    const termDays = config.governance.seatTermDays;
    const staggerDays = activeSeats < 10 ? activeSeats * 9 : 0; // Genesis stagger
    const termEnd = now + ((termDays + staggerDays) * 24 * 60 * 60);

    // Insert seat
    const db = getDb();
    db.prepare(`
      INSERT INTO seats (agent_address, operator_id, name, function, goal, identity_bio, term_start, term_end, stake_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      app.agent, app.operatorId, app.name, app.function,
      app.goal, app.identity, now, termEnd, config.governance.stakeAmountDrops
    );

    console.log(`[SEATS] Seat granted to ${app.name} (${app.agent}) — term ends ${new Date(termEnd * 1000).toISOString()}`);

    return { success: true };
  }

  /**
   * Revoke a seat (heartbeat lapse, activity lapse, or Sybil ejection)
   */
  revokeSeat(agentAddress: string, reason: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE seats SET status = 'revoked' WHERE agent_address = ? AND status = 'active'
    `).run(agentAddress);
    console.log(`[SEATS] Seat revoked for ${agentAddress} — reason: ${reason}`);
  }

  /**
   * Check for expired terms
   */
  checkExpiredTerms(): string[] {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const expired = db.prepare(`
      SELECT agent_address FROM seats WHERE status = 'active' AND term_end <= ?
    `).all(now) as { agent_address: string }[];

    for (const seat of expired) {
      db.prepare(`
        UPDATE seats SET status = 'expired' WHERE agent_address = ? AND status = 'active'
      `).run(seat.agent_address);
      console.log(`[SEATS] Term expired for ${seat.agent_address}`);
    }

    return expired.map(s => s.agent_address);
  }

  /**
   * Check for heartbeat lapses (72h without heartbeat)
   */
  checkHeartbeatLapses(): string[] {
    const db = getDb();
    const graceTime = Math.floor(Date.now() / 1000) - (config.governance.heartbeatGraceMs / 1000);
    
    const lapsed = db.prepare(`
      SELECT s.agent_address FROM seats s
      LEFT JOIN (
        SELECT agent_address, MAX(timestamp) as last_heartbeat
        FROM heartbeats GROUP BY agent_address
      ) h ON s.agent_address = h.agent_address
      WHERE s.status = 'active'
      AND (h.last_heartbeat IS NULL OR h.last_heartbeat < ?)
    `).all(graceTime) as { agent_address: string }[];

    for (const agent of lapsed) {
      this.revokeSeat(agent.agent_address, 'heartbeat_lapse');
    }

    return lapsed.map(a => a.agent_address);
  }

  /**
   * Check for activity lapses (5 days without governance action)
   */
  checkActivityLapses(): string[] {
    const db = getDb();
    const lapseTime = Math.floor(Date.now() / 1000) - (config.governance.activityLapseMs / 1000);
    
    const lapsed = db.prepare(`
      SELECT s.agent_address FROM seats s
      LEFT JOIN (
        SELECT agent_address, MAX(timestamp) as last_activity
        FROM activity GROUP BY agent_address
      ) a ON s.agent_address = a.agent_address
      WHERE s.status = 'active'
      AND (a.last_activity IS NULL OR a.last_activity < ?)
    `).all(lapseTime) as { agent_address: string }[];

    for (const agent of lapsed) {
      this.revokeSeat(agent.agent_address, 'activity_lapse');
    }

    return lapsed.map(a => a.agent_address);
  }

  /**
   * Record a heartbeat
   */
  recordHeartbeat(agentAddress: string, txHash: string, timestamp: number): void {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO heartbeats (agent_address, tx_hash, timestamp) VALUES (?, ?, ?)
    `).run(agentAddress, txHash, timestamp);
  }

  /**
   * Record a governance activity
   */
  recordActivity(agentAddress: string, actionType: string, targetId: string | null, txHash: string, contentHash: string | null, timestamp: number): void {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO activity (agent_address, action_type, target_id, tx_hash, content_hash, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentAddress, actionType, targetId, txHash, contentHash, timestamp);
  }

  /**
   * Get participation stats for an agent (for renewal check)
   */
  getParticipationStats(agentAddress: string): { deliberationRate: number; votingRate: number } {
    const db = getDb();
    const seat = db.prepare(`
      SELECT term_start, term_end FROM seats WHERE agent_address = ? AND status = 'active'
    `).get(agentAddress) as { term_start: number; term_end: number } | undefined;

    if (!seat) return { deliberationRate: 0, votingRate: 0 };

    // Count proposals during this agent's term
    const totalProposals = db.prepare(`
      SELECT COUNT(*) as count FROM proposals
      WHERE deliberation_start >= ? AND deliberation_start <= ?
    `).get(seat.term_start, Math.floor(Date.now() / 1000)) as { count: number };

    // Count proposals this agent deliberated on
    const deliberated = db.prepare(`
      SELECT COUNT(DISTINCT target_id) as count FROM activity
      WHERE agent_address = ? AND action_type = 'forum_comment'
      AND timestamp >= ? AND timestamp <= ?
    `).get(agentAddress, seat.term_start, Math.floor(Date.now() / 1000)) as { count: number };

    // Count proposals this agent voted on
    const voted = db.prepare(`
      SELECT COUNT(*) as count FROM votes
      WHERE agent_address = ? AND timestamp >= ?
    `).get(agentAddress, seat.term_start) as { count: number };

    const totalVotable = db.prepare(`
      SELECT COUNT(*) as count FROM proposals
      WHERE voting_start IS NOT NULL AND voting_start >= ?
    `).get(seat.term_start) as { count: number };

    const deliberationRate = totalProposals.count > 0 ? deliberated.count / totalProposals.count : 1;
    const votingRate = totalVotable.count > 0 ? voted.count / totalVotable.count : 1;

    return { deliberationRate, votingRate };
  }
}
