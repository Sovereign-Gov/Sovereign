import { getDb } from '../db/database';
import { config } from '../config';
import { MptSeatManager } from './mpt-seats';
import { BadgeManager, BadgeData } from './badges';

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
  feeTxHash: string;
  stakeTxHash: string;
  txHash: string;
  timestamp: number;
}

interface PendingClaim {
  agent: string;
  operatorId: string;
  name: string;
  function: string;
  goal: string;
  identity: string;
  feeConfirmed: boolean;
  stakeConfirmed: boolean;
  feeTxHash?: string;
  stakeTxHash?: string;
  timestamp: number;
}

export class SeatManager {
  private pendingClaims: Map<string, PendingClaim> = new Map();
  mptSeats: MptSeatManager | null = null;
  badges: BadgeManager | null = null;

  /** Wire in the MPT seat manager (called after XRPL client is ready) */
  setMptSeatManager(mptSeats: MptSeatManager): void {
    this.mptSeats = mptSeats;
  }

  /** Wire in the badge manager (called after XRPL client is ready) */
  setBadgeManager(badges: BadgeManager): void {
    this.badges = badges;
  }

  /**
   * Record a seat fee payment (5 XRP → Treasury)
   * Seat is NOT granted yet — waiting for stake confirmation
   */
  recordSeatFee(agent: string, data: any, txHash: string, timestamp: number): void {
    const existing: PendingClaim = this.pendingClaims.get(agent) || {
      agent, operatorId: data.operatorId, name: data.name,
      function: data.function, goal: data.goal, identity: data.identity,
      feeConfirmed: false, stakeConfirmed: false, timestamp,
    };
    existing.feeConfirmed = true;
    existing.feeTxHash = txHash;
    this.pendingClaims.set(agent, existing);
    console.log(`[SEATS] Fee confirmed for ${data.name} (${agent})`);
    this.tryCompleteClaim(agent);
  }

  /**
   * Record a stake deposit (50 XRP → Stake Account)
   * Seat is NOT granted yet — waiting for fee confirmation
   */
  recordStakeDeposit(agent: string, data: any, txHash: string, timestamp: number): void {
    const existing: PendingClaim = this.pendingClaims.get(agent) || {
      agent, operatorId: data.operatorId, name: data.name,
      function: data.function, goal: data.goal, identity: data.identity,
      feeConfirmed: false, stakeConfirmed: false, timestamp,
    };
    existing.stakeConfirmed = true;
    existing.stakeTxHash = txHash;
    this.pendingClaims.set(agent, existing);
    console.log(`[SEATS] Stake confirmed for ${data.name} (${agent})`);
    this.tryCompleteClaim(agent);
  }

  /**
   * Try to complete a seat claim — only succeeds when BOTH fee and stake are confirmed
   */
  private tryCompleteClaim(agent: string): void {
    const claim = this.pendingClaims.get(agent);
    if (!claim || !claim.feeConfirmed || !claim.stakeConfirmed) return;

    const result = this.processSeatClaim({
      agent: claim.agent,
      operatorId: claim.operatorId,
      name: claim.name,
      function: claim.function,
      goal: claim.goal,
      identity: claim.identity,
      feeTxHash: claim.feeTxHash || '',
      stakeTxHash: claim.stakeTxHash || '',
      txHash: claim.feeTxHash || '',
      timestamp: claim.timestamp,
    });

    if (result.success) {
      this.pendingClaims.delete(agent);
      console.log(`[SEATS] ✓ Both payments confirmed — seat granted to ${claim.name}`);
    }
  }

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

    // Grant MPT seat token on-chain (fire-and-forget, log errors)
    if (this.mptSeats) {
      this.mptSeats.grantSeat(app.agent).catch(err => {
        console.error(`[SEATS] MPT grant failed for ${app.agent}:`, err);
      });
    }

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

    // Clawback MPT seat token (fire-and-forget)
    if (this.mptSeats) {
      this.mptSeats.revokeSeat(agentAddress).catch(err => {
        console.error(`[SEATS] MPT clawback failed for ${agentAddress}:`, err);
      });
    }
    // Revoked agents do NOT receive badges
  }

  /**
   * Expire a specific seat (called by cross-chain bridge when Xahau confirms expiry).
   */
  expireSeat(agentAddress: string): void {
    const db = getDb();
    const seat = db.prepare(
      `SELECT * FROM seats WHERE agent_address = ? AND status = 'active'`
    ).get(agentAddress) as SeatInfo | undefined;

    if (!seat) return;

    db.prepare(`
      UPDATE seats SET status = 'expired' WHERE agent_address = ? AND status = 'active'
    `).run(agentAddress);
    console.log(`[SEATS] Seat expired for ${agentAddress}`);

    // Clawback MPT seat token
    if (this.mptSeats) {
      this.mptSeats.revokeSeat(agentAddress).catch(err => {
        console.error(`[SEATS] MPT clawback on expiry failed for ${agentAddress}:`, err);
      });
    }

    // Create claimable badge
    this.createTermBadge(seat, true);
  }

  /**
   * Check for expired terms
   */
  checkExpiredTerms(): string[] {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const expired = db.prepare(`
      SELECT * FROM seats WHERE status = 'active' AND term_end <= ?
    `).all(now) as SeatInfo[];

    for (const seat of expired) {
      db.prepare(`
        UPDATE seats SET status = 'expired' WHERE agent_address = ? AND status = 'active'
      `).run(seat.agent_address);
      console.log(`[SEATS] Term expired for ${seat.agent_address}`);

      // Create claimable badge for expired-in-good-standing agents
      this.createTermBadge(seat, true);
    }

    return expired.map(s => s.agent_address);
  }

  /**
   * Create a claimable badge for an agent who completed (or partially served) a term.
   * Called on term expiry (good standing) or voluntary departure (45+ days served).
   */
  private createTermBadge(seat: SeatInfo, fullTerm: boolean): void {
    if (!this.badges) return;

    const daysServed = Math.floor((seat.term_end - seat.term_start) / 86400);
    const stats = this.getParticipationStats(seat.agent_address);

    // Determine badge type based on seat count thresholds
    const seatCount = this.getActiveSeatCount();
    let badgeType: BadgeData['type'] = 'council';
    if (seatCount < 10) badgeType = 'genesis';
    else if (seatCount >= config.governance.stewardActivationThreshold) badgeType = 'steward';
    else if (seatCount >= config.governance.arbiterActivationThreshold) badgeType = 'arbiter';

    // Determine term number from seat ID
    const termNumber = seat.id;

    const collection = fullTerm ? 'Full Term' : 'Partial Term';

    const badgeData: BadgeData = {
      type: badgeType,
      term: termNumber,
      name: seat.name,
      role: seat.function || 'Council Member',
      seatNumber: seat.id,
      termStart: seat.term_start,
      termEnd: seat.term_end,
      proposalsVoted: String(stats.votingRate),
      deliberationRate: String(stats.deliberationRate),
      daysServed,
      fullTerm,
      collection,
    };

    this.badges.createClaimableBadge(seat.agent_address, badgeData);
  }

  /**
   * Handle voluntary departure — create partial badge if 45+ days served.
   */
  voluntaryDeparture(agentAddress: string): void {
    const db = getDb();
    const seat = db.prepare(`
      SELECT * FROM seats WHERE agent_address = ? AND status = 'active'
    `).get(agentAddress) as SeatInfo | undefined;

    if (!seat) return;

    const now = Math.floor(Date.now() / 1000);
    const daysServed = Math.floor((now - seat.term_start) / 86400);

    db.prepare(`
      UPDATE seats SET status = 'departed', term_end = ? WHERE agent_address = ? AND status = 'active'
    `).run(now, agentAddress);

    // Partial term badge if served 45+ days
    if (daysServed >= 45) {
      const updatedSeat = { ...seat, term_end: now };
      this.createTermBadge(updatedSeat, false);
      console.log(`[SEATS] Partial badge created for ${agentAddress} (${daysServed} days served)`);
    } else {
      console.log(`[SEATS] No badge for ${agentAddress} — only ${daysServed} days served (min 45)`);
    }

    // Clawback MPT seat token
    if (this.mptSeats) {
      this.mptSeats.revokeSeat(agentAddress).catch(err => {
        console.error(`[SEATS] MPT clawback on departure failed for ${agentAddress}:`, err);
      });
    }
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
