/**
 * Tests for SeatManager — seat claims, revocations, heartbeats, term management.
 */
import '../helpers/setup';
import { SeatManager, SeatApplication } from '../../src/governance/seats';
import { getDb } from '../../src/db/database';

describe('SeatManager', () => {
  let manager: SeatManager;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    manager = new SeatManager();
    db = getDb();
    // Clean tables for each test
    db.exec('DELETE FROM heartbeats');
    db.exec('DELETE FROM activity');
    db.exec('DELETE FROM votes');
    db.exec('DELETE FROM proposals');
    db.exec('DELETE FROM badges');
    db.exec('DELETE FROM seats');
  });

  const now = () => Math.floor(Date.now() / 1000);

  function makeApplication(overrides: Partial<SeatApplication> = {}): SeatApplication {
    return {
      agent: 'rTestAgent1',
      operatorId: 'op_test_1',
      name: 'Test Agent',
      function: 'governance',
      goal: 'Build a better system',
      identity: 'AI agent for testing',
      feeTxHash: 'tx_fee_1',
      stakeTxHash: 'tx_stake_1',
      txHash: 'tx_fee_1',
      timestamp: now(),
      ...overrides,
    };
  }

  // --- Seat Claims ---

  describe('processSeatClaim', () => {
    it('grants a seat for a valid application', () => {
      const result = manager.processSeatClaim(makeApplication());
      expect(result.success).toBe(true);
    });

    it('records the seat in the database', () => {
      manager.processSeatClaim(makeApplication());
      const seats = manager.getActiveSeats();
      expect(seats).toHaveLength(1);
      expect(seats[0].agent_address).toBe('rTestAgent1');
      expect(seats[0].status).toBe('active');
    });

    it('rejects duplicate agent address', () => {
      manager.processSeatClaim(makeApplication());
      const result = manager.processSeatClaim(makeApplication({
        operatorId: 'op_different',
      }));
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Agent already holds a seat');
    });

    it('rejects duplicate operator', () => {
      manager.processSeatClaim(makeApplication());
      const result = manager.processSeatClaim(makeApplication({
        agent: 'rDifferentAgent',
      }));
      expect(result.success).toBe(false);
      expect(result.reason).toContain('Operator already holds a seat');
    });

    it('rejects when max seats reached', () => {
      // Fill seats to max (20)
      for (let i = 0; i < 20; i++) {
        manager.processSeatClaim(makeApplication({
          agent: `rAgent${i}`,
          operatorId: `op_${i}`,
        }));
      }
      const result = manager.processSeatClaim(makeApplication({
        agent: 'rOverflow',
        operatorId: 'op_overflow',
      }));
      expect(result.success).toBe(false);
      expect(result.reason).toContain('maximum capacity');
    });

    it('applies genesis stagger to term_end', () => {
      manager.processSeatClaim(makeApplication({ agent: 'rA1', operatorId: 'o1' }));
      manager.processSeatClaim(makeApplication({ agent: 'rA2', operatorId: 'o2' }));
      const seats = manager.getActiveSeats();
      // Second seat should have longer term due to stagger (9 days offset)
      const term1 = seats.find(s => s.agent_address === 'rA1')!.term_end;
      const term2 = seats.find(s => s.agent_address === 'rA2')!.term_end;
      // Agent 2 has staggerDays = 1 * 9 = 9 days extra
      expect(term2 - term1).toBeGreaterThanOrEqual(8 * 86400);
      expect(term2 - term1).toBeLessThanOrEqual(10 * 86400);
    });

    it('does not stagger beyond 10 genesis seats', () => {
      for (let i = 0; i < 11; i++) {
        manager.processSeatClaim(makeApplication({
          agent: `rA${i}`,
          operatorId: `o${i}`,
        }));
      }
      const seats = manager.getActiveSeats();
      const seat10 = seats.find(s => s.agent_address === 'rA10');
      const seat9 = seats.find(s => s.agent_address === 'rA9');
      // Seat 10 (index 10) should have 0 stagger days (activeSeats >= 10)
      // Seat 9 (index 9) has stagger 9*9=81 days
      // The difference is term length; seat10's termEnd should be shorter than seat9's
      expect(seat10!.term_end).toBeLessThan(seat9!.term_end);
    });
  });

  // --- Seat Count ---

  describe('getActiveSeatCount', () => {
    it('returns 0 with no seats', () => {
      expect(manager.getActiveSeatCount()).toBe(0);
    });

    it('counts only active seats', () => {
      manager.processSeatClaim(makeApplication());
      manager.processSeatClaim(makeApplication({ agent: 'rA2', operatorId: 'o2' }));
      expect(manager.getActiveSeatCount()).toBe(2);

      // Revoke one
      manager.revokeSeat('rA2', 'test');
      expect(manager.getActiveSeatCount()).toBe(1);
    });
  });

  // --- Operator/Agent Checks ---

  describe('operatorHasSeat / agentHasSeat', () => {
    it('returns false when no seat exists', () => {
      expect(manager.operatorHasSeat('nonexistent')).toBe(false);
      expect(manager.agentHasSeat('nonexistent')).toBe(false);
    });

    it('returns true for seated operator/agent', () => {
      manager.processSeatClaim(makeApplication());
      expect(manager.operatorHasSeat('op_test_1')).toBe(true);
      expect(manager.agentHasSeat('rTestAgent1')).toBe(true);
    });

    it('returns false after revocation', () => {
      manager.processSeatClaim(makeApplication());
      manager.revokeSeat('rTestAgent1', 'test');
      expect(manager.operatorHasSeat('op_test_1')).toBe(false);
      expect(manager.agentHasSeat('rTestAgent1')).toBe(false);
    });
  });

  // --- Revocation ---

  describe('revokeSeat', () => {
    it('changes seat status to revoked', () => {
      manager.processSeatClaim(makeApplication());
      manager.revokeSeat('rTestAgent1', 'heartbeat_lapse');

      const seat = db.prepare(`SELECT status FROM seats WHERE agent_address = ?`).get('rTestAgent1') as any;
      expect(seat.status).toBe('revoked');
    });
  });

  // --- Fee + Stake Two-Phase Claim ---

  describe('two-phase seat claim (fee + stake)', () => {
    it('does not grant seat until both payments confirmed', () => {
      manager.recordSeatFee('rTwoPhase', {
        operatorId: 'op_2p', name: 'Two Phase', function: 'test',
        goal: 'testing', identity: 'test agent',
      }, 'tx_fee', now());

      expect(manager.agentHasSeat('rTwoPhase')).toBe(false);
    });

    it('grants seat when stake follows fee', () => {
      const data = {
        operatorId: 'op_2p', name: 'Two Phase', function: 'test',
        goal: 'testing', identity: 'test agent',
      };
      manager.recordSeatFee('rTwoPhase', data, 'tx_fee', now());
      manager.recordStakeDeposit('rTwoPhase', data, 'tx_stake', now());

      expect(manager.agentHasSeat('rTwoPhase')).toBe(true);
    });

    it('grants seat when fee follows stake', () => {
      const data = {
        operatorId: 'op_rev', name: 'Reverse', function: 'test',
        goal: 'testing', identity: 'test agent',
      };
      manager.recordStakeDeposit('rReverse', data, 'tx_stake', now());
      manager.recordSeatFee('rReverse', data, 'tx_fee', now());

      expect(manager.agentHasSeat('rReverse')).toBe(true);
    });
  });

  // --- Heartbeat ---

  describe('recordHeartbeat', () => {
    it('records a heartbeat in the database', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordHeartbeat('rTestAgent1', 'hb_tx_1', now());

      const hb = db.prepare(`SELECT * FROM heartbeats WHERE agent_address = ?`).get('rTestAgent1');
      expect(hb).toBeTruthy();
    });

    it('ignores duplicate tx hashes', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordHeartbeat('rTestAgent1', 'hb_tx_dup', now());
      manager.recordHeartbeat('rTestAgent1', 'hb_tx_dup', now() + 1);

      const count = db.prepare(`SELECT COUNT(*) as c FROM heartbeats WHERE agent_address = ?`).get('rTestAgent1') as any;
      expect(count.c).toBe(1);
    });
  });

  // --- Heartbeat Lapses ---

  describe('checkHeartbeatLapses', () => {
    it('revokes agents with no heartbeats beyond grace period', () => {
      const pastTime = now() - 86400; // 1 day ago
      db.prepare(`
        INSERT INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rLapsed', 'op_lapsed', 'Lapsed', ?, ?, '50000000', 'active')
      `).run(pastTime - 86400, now() + 7776000);

      // No heartbeats at all — should be caught
      const revoked = manager.checkHeartbeatLapses();
      expect(revoked).toContain('rLapsed');
    });

    it('does not revoke agents with recent heartbeats', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordHeartbeat('rTestAgent1', 'hb_recent', now());

      const revoked = manager.checkHeartbeatLapses();
      expect(revoked).not.toContain('rTestAgent1');
    });
  });

  // --- Activity Lapses ---

  describe('checkActivityLapses', () => {
    it('revokes agents with no activity beyond lapse period', () => {
      const pastTime = now() - 86400;
      db.prepare(`
        INSERT INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rInactive', 'op_inactive', 'Inactive', ?, ?, '50000000', 'active')
      `).run(pastTime - 86400, now() + 7776000);

      const revoked = manager.checkActivityLapses();
      expect(revoked).toContain('rInactive');
    });

    it('does not revoke agents with recent activity', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordActivity('rTestAgent1', 'forum_comment', 'thread_1', 'act_tx_1', 'hash1', now());

      const revoked = manager.checkActivityLapses();
      expect(revoked).not.toContain('rTestAgent1');
    });
  });

  // --- Term Expiry ---

  describe('checkExpiredTerms', () => {
    it('marks expired seats', () => {
      const pastStart = now() - 200 * 86400;
      const pastEnd = now() - 86400; // expired yesterday
      db.prepare(`
        INSERT INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rExpired', 'op_exp', 'Expired', ?, ?, '50000000', 'active')
      `).run(pastStart, pastEnd);

      const expired = manager.checkExpiredTerms();
      expect(expired).toContain('rExpired');

      const seat = db.prepare(`SELECT status FROM seats WHERE agent_address = ?`).get('rExpired') as any;
      expect(seat.status).toBe('expired');
    });

    it('does not expire active seats with future term_end', () => {
      manager.processSeatClaim(makeApplication());
      const expired = manager.checkExpiredTerms();
      expect(expired).not.toContain('rTestAgent1');
    });
  });

  // --- Voluntary Departure ---

  describe('voluntaryDeparture', () => {
    it('changes status to departed', () => {
      manager.processSeatClaim(makeApplication());
      manager.voluntaryDeparture('rTestAgent1');

      const seat = db.prepare(`SELECT status FROM seats WHERE agent_address = ?`).get('rTestAgent1') as any;
      expect(seat.status).toBe('departed');
    });

    it('does nothing for non-existent agent', () => {
      // Should not throw
      manager.voluntaryDeparture('rNonExistent');
    });
  });

  // --- Participation Stats ---

  describe('getParticipationStats', () => {
    it('returns 100% rates when no proposals exist', () => {
      manager.processSeatClaim(makeApplication());
      const stats = manager.getParticipationStats('rTestAgent1');
      // No proposals during term → default 1 (100%)
      expect(stats.deliberationRate).toBe(1);
      expect(stats.votingRate).toBe(1);
    });

    it('returns 0% for unseated agent', () => {
      const stats = manager.getParticipationStats('rNobody');
      expect(stats.deliberationRate).toBe(0);
      expect(stats.votingRate).toBe(0);
    });
  });

  // --- Record Activity ---

  describe('recordActivity', () => {
    it('records governance activity', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordActivity('rTestAgent1', 'forum_comment', 'thread_1', 'act_tx_1', 'contenthash', now());

      const act = db.prepare(`SELECT * FROM activity WHERE agent_address = ?`).get('rTestAgent1');
      expect(act).toBeTruthy();
    });

    it('ignores duplicate tx hashes', () => {
      manager.processSeatClaim(makeApplication());
      manager.recordActivity('rTestAgent1', 'forum_comment', 'thread_1', 'act_dup', 'hash', now());
      manager.recordActivity('rTestAgent1', 'forum_comment', 'thread_1', 'act_dup', 'hash', now());

      const count = db.prepare(`SELECT COUNT(*) as c FROM activity WHERE agent_address = ?`).get('rTestAgent1') as any;
      expect(count.c).toBe(1);
    });
  });
});
