import { EventEmitter } from 'events';
import { XrplWatcher } from './xrpl-watcher';
import { XahauWatcher, XahauSeatEntry, BranchActivationState, RotationState } from './xahau-watcher';
import { getDb } from '../db/database';
import { config } from '../config';

/**
 * Cross-chain state consistency status.
 */
export interface ConsistencyReport {
  timestamp: number;
  seatCountXrpl: number;
  seatCountXahau: number;
  mismatches: StateMismatch[];
  isConsistent: boolean;
}

export interface StateMismatch {
  type: 'seat_missing_xahau' | 'seat_missing_xrpl' | 'seat_status_mismatch'
      | 'heartbeat_drift' | 'vote_mismatch' | 'governance_lock_mismatch';
  agentAddress?: string;
  details: string;
  severity: 'warning' | 'critical';
}

/**
 * Unified governance event that downstream consumers subscribe to.
 * All events from both chains are normalized into this format.
 */
export interface GovernanceEvent {
  type: string;
  source: 'xrpl' | 'xahau' | 'bridge';
  data: Record<string, any>;
  timestamp: number;
  txHash?: string;
}

/**
 * Network health status for outage detection.
 */
interface NetworkHealth {
  xrpl: { connected: boolean; lastEvent: number };
  xahau: { connected: boolean; lastEvent: number };
}

/**
 * CrossChainBridge — coordinates events between the XRPL watcher and
 * the Xahau watcher, ensuring state consistency across the dual-chain
 * governance model.
 *
 * Architecture per ARCHITECTURE.md:
 *   - XRPL: treasury/voting records/seat NFTs/forum hashes/heartbeats/payments
 *   - Xahau: governance Hooks/seat registry/rule enforcement/sybil detection
 *
 * The bridge:
 *   1. Listens to both watchers
 *   2. Correlates events across chains (e.g., XRPL seat_claim → Xahau seat_added)
 *   3. Detects and reports state inconsistencies
 *   4. Emits unified GovernanceEvents for the orchestrator
 *   5. Handles network outages gracefully (pauses deadlines)
 */
export class CrossChainBridge extends EventEmitter {
  private xrplWatcher: XrplWatcher;
  private xahauWatcher: XahauWatcher;
  private running = false;
  private intervals: NodeJS.Timeout[] = [];

  // Network health tracking
  private networkHealth: NetworkHealth = {
    xrpl: { connected: false, lastEvent: 0 },
    xahau: { connected: false, lastEvent: 0 },
  };

  // Pending cross-chain operations awaiting confirmation from the other chain
  private pendingXrplToXahau = new Map<string, { event: string; data: any; timestamp: number }>();
  private pendingXahauToXrpl = new Map<string, { event: string; data: any; timestamp: number }>();

  // Outage tracking
  private outageDetected = false;
  private outageStartedAt: number | null = null;

  // Last known states for consistency checking
  private lastBranchState: BranchActivationState | null = null;
  private lastRotationState: RotationState | null = null;

  constructor(xrplWatcher: XrplWatcher, xahauWatcher: XahauWatcher) {
    super();
    this.xrplWatcher = xrplWatcher;
    this.xahauWatcher = xahauWatcher;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log('[BRIDGE] Starting cross-chain bridge...');

    // Wire XRPL events
    this.wireXrplEvents();

    // Wire Xahau events (only if Xahau watcher is running)
    if (this.xahauWatcher.isRunning()) {
      this.wireXahauEvents();
    }

    // Start periodic consistency checks
    this.startConsistencyChecks();

    // Start network health monitoring
    this.startHealthMonitor();

    console.log('[BRIDGE] Cross-chain bridge running');
  }

  // === XRPL Event Wiring ===

  private wireXrplEvents(): void {
    // Track XRPL heartbeats — expect Xahau Hook to also record them
    this.xrplWatcher.on('heartbeat', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();

      // Emit unified event
      this.emitGovernanceEvent({
        type: 'heartbeat',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });

      // Track: we expect Xahau to also record this heartbeat
      this.pendingXrplToXahau.set(`heartbeat:${event.agent}:${event.txHash}`, {
        event: 'heartbeat',
        data: event,
        timestamp: Date.now(),
      });
    });

    // Track XRPL seat claims — expect Xahau Hook state to reflect the new seat
    this.xrplWatcher.on('seat_claim', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'seat_claim',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });

      this.pendingXrplToXahau.set(`seat_claim:${event.agent}`, {
        event: 'seat_claim',
        data: event,
        timestamp: Date.now(),
      });
    });

    // Track XRPL votes — Xahau Hook should validate and record them
    this.xrplWatcher.on('vote', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'vote',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });

      this.pendingXrplToXahau.set(`vote:${event.agent}:${event.data.proposalId}`, {
        event: 'vote',
        data: event,
        timestamp: Date.now(),
      });
    });

    // Track proposals
    this.xrplWatcher.on('proposal', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'proposal',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Track forum posts
    this.xrplWatcher.on('forum_post', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'forum_post',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Track seat fees and stakes
    this.xrplWatcher.on('seat_fee', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'seat_fee',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    this.xrplWatcher.on('seat_stake', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'seat_stake',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Track challenges
    this.xrplWatcher.on('challenge', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'challenge',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Track vouches
    this.xrplWatcher.on('vouch', (event) => {
      this.networkHealth.xrpl.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'vouch',
        source: 'xrpl',
        data: event,
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });
  }

  // === Xahau Event Wiring ===

  private wireXahauEvents(): void {
    // Xahau heartbeat confirmation — resolve pending XRPL heartbeat
    this.xahauWatcher.on('xahau_heartbeat', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();

      const pendingKey = `heartbeat:${event.agent}:${event.txHash}`;
      if (this.pendingXrplToXahau.has(pendingKey)) {
        this.pendingXrplToXahau.delete(pendingKey);
      }

      this.emitGovernanceEvent({
        type: 'heartbeat_confirmed',
        source: 'xahau',
        data: { ...event, hookValidated: true },
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Xahau seat added — resolve pending XRPL seat claim
    this.xahauWatcher.on('xahau_seat_added', (seat: XahauSeatEntry) => {
      this.networkHealth.xahau.lastEvent = Date.now();

      const pendingKey = `seat_claim:${seat.agentAddress}`;
      if (this.pendingXrplToXahau.has(pendingKey)) {
        this.pendingXrplToXahau.delete(pendingKey);
        console.log(`[BRIDGE] Seat claim confirmed on Xahau: ${seat.agentAddress}`);
      }

      this.emitGovernanceEvent({
        type: 'seat_confirmed',
        source: 'xahau',
        data: seat,
        timestamp: seat.termStart,
      });
    });

    // Xahau seat updated
    this.xahauWatcher.on('xahau_seat_updated', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'seat_updated',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });
    });

    // Xahau seat revoked — trigger XRPL-side cleanup
    this.xahauWatcher.on('xahau_seat_revoked_state', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'seat_revoked',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });

      // Signal that XRPL side needs to process this revocation
      // (burn seat NFT/MPT, trigger stake refund, etc.)
      this.emit('xrpl_action_required', {
        action: 'process_revocation',
        agentAddress: event.agentAddress,
        seatIndex: event.seatIndex,
        source: 'xahau_hook',
      });
      console.log(`[BRIDGE] Xahau revocation → XRPL action required for ${event.agentAddress}`);
    });

    // Xahau seat expired
    this.xahauWatcher.on('xahau_seat_expired', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();

      this.emitGovernanceEvent({
        type: 'seat_expired',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });

      this.emit('xrpl_action_required', {
        action: 'process_expiry',
        agentAddress: event.agentAddress,
        seatIndex: event.seatIndex,
        termEnd: event.termEnd,
      });
    });

    // Xahau vote validated — resolve pending XRPL vote
    this.xahauWatcher.on('xahau_vote_validated', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();

      const pendingKey = `vote:${event.agent}:${event.proposalId}`;
      if (this.pendingXrplToXahau.has(pendingKey)) {
        this.pendingXrplToXahau.delete(pendingKey);
      }

      this.emitGovernanceEvent({
        type: 'vote_confirmed',
        source: 'xahau',
        data: { ...event, hookValidated: true },
        timestamp: event.timestamp,
        txHash: event.txHash,
      });
    });

    // Branch activation events — these are Xahau-only (Hook triggered)
    this.xahauWatcher.on('xahau_branch_state', (state: BranchActivationState) => {
      this.networkHealth.xahau.lastEvent = Date.now();
      this.lastBranchState = state;

      this.emitGovernanceEvent({
        type: 'branch_state',
        source: 'xahau',
        data: state,
        timestamp: Date.now(),
      });
    });

    this.xahauWatcher.on('xahau_stewards_activated', (event) => {
      this.emitGovernanceEvent({
        type: 'stewards_activated',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });
      console.log('[BRIDGE] 🏛️ Steward branch activated — governance expansion');
    });

    this.xahauWatcher.on('xahau_arbiters_activated', (event) => {
      this.emitGovernanceEvent({
        type: 'arbiters_activated',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });
      console.log('[BRIDGE] ⚔️ Arbiter branch activated — full three-branch governance');
    });

    // Rotation enforcement — Xahau-driven, XRPL must comply
    this.xahauWatcher.on('xahau_rotation_state', (state: RotationState) => {
      this.networkHealth.xahau.lastEvent = Date.now();
      this.lastRotationState = state;

      this.emitGovernanceEvent({
        type: 'rotation_state',
        source: 'xahau',
        data: state,
        timestamp: Date.now(),
      });
    });

    this.xahauWatcher.on('xahau_rotation_required', (event) => {
      this.emit('xrpl_action_required', {
        action: 'signer_rotation',
        deadline: event.deadline,
        frozenAccounts: event.frozenAccounts,
      });
      console.log(`[BRIDGE] ⚠️ Signer rotation required — XRPL must update SignerList by ${event.deadline ? new Date(event.deadline * 1000).toISOString() : 'ASAP'}`);
    });

    this.xahauWatcher.on('xahau_accounts_frozen', (event) => {
      this.emit('xrpl_action_required', {
        action: 'accounts_frozen',
        accounts: event.accounts,
      });
      console.log(`[BRIDGE] 🔒 Accounts frozen by Xahau Hook — XRPL spending blocked for: ${event.accounts.join(', ')}`);
    });

    // Constitution ratification — Xahau confirms, XRPL governance unlocks
    this.xahauWatcher.on('xahau_constitution_ratified', (event) => {
      this.emitGovernanceEvent({
        type: 'constitution_ratified',
        source: 'xahau',
        data: event,
        timestamp: event.timestamp,
      });
      console.log('[BRIDGE] ⚖️ Constitution ratified on Xahau — full governance unlocked');
    });

    // Governance lock state
    this.xahauWatcher.on('xahau_governance_lock', (event) => {
      this.emitGovernanceEvent({
        type: 'governance_lock',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });
    });

    // State mismatch alerts from Xahau watcher's deep audit
    this.xahauWatcher.on('xahau_state_mismatch', (event) => {
      this.emitGovernanceEvent({
        type: 'state_mismatch',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
      });
      console.warn(`[BRIDGE] State mismatch detected: ${event.message}`);
    });

    // Hook execution events (audit trail)
    this.xahauWatcher.on('hook_execution', (event) => {
      this.networkHealth.xahau.lastEvent = Date.now();
      this.emitGovernanceEvent({
        type: 'hook_execution',
        source: 'xahau',
        data: event,
        timestamp: Date.now(),
        txHash: event.txHash,
      });
    });
  }

  // === Consistency Checking ===

  private startConsistencyChecks(): void {
    // Check for unresolved pending cross-chain operations every 2 minutes
    const pendingCheckInterval = setInterval(() => {
      this.checkPendingOperations();
    }, 2 * 60 * 1000);
    this.intervals.push(pendingCheckInterval);

    // Full cross-chain consistency report every 10 minutes
    const consistencyInterval = setInterval(async () => {
      try {
        const report = await this.runConsistencyCheck();
        if (!report.isConsistent) {
          this.emit('consistency_report', report);
          console.warn(`[BRIDGE] Consistency check: ${report.mismatches.length} mismatches found`);
        }
      } catch (err) {
        console.error('[BRIDGE] Consistency check error:', err);
      }
    }, 10 * 60 * 1000);
    this.intervals.push(consistencyInterval);
  }

  /**
   * Check for cross-chain operations that haven't been confirmed.
   * If an XRPL event (e.g., heartbeat) hasn't been confirmed by Xahau
   * within a reasonable window, emit a warning.
   */
  private checkPendingOperations(): void {
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    // Check XRPL → Xahau pending operations
    for (const [key, pending] of this.pendingXrplToXahau) {
      if (now - pending.timestamp > staleThresholdMs) {
        // If we're in an outage, don't flag — it's expected
        if (!this.outageDetected) {
          this.emit('cross_chain_stale', {
            direction: 'xrpl_to_xahau',
            key,
            event: pending.event,
            data: pending.data,
            waitingMs: now - pending.timestamp,
          });
          console.warn(`[BRIDGE] Stale pending operation: ${key} (waiting ${Math.round((now - pending.timestamp) / 1000)}s)`);
        }
        // Remove very old entries to prevent unbounded growth
        if (now - pending.timestamp > 30 * 60 * 1000) {
          this.pendingXrplToXahau.delete(key);
        }
      }
    }

    // Check Xahau → XRPL pending operations
    for (const [key, pending] of this.pendingXahauToXrpl) {
      if (now - pending.timestamp > staleThresholdMs) {
        if (!this.outageDetected) {
          this.emit('cross_chain_stale', {
            direction: 'xahau_to_xrpl',
            key,
            event: pending.event,
            data: pending.data,
            waitingMs: now - pending.timestamp,
          });
        }
        if (now - pending.timestamp > 30 * 60 * 1000) {
          this.pendingXahauToXrpl.delete(key);
        }
      }
    }
  }

  /**
   * Run a full cross-chain consistency check.
   * Compares XRPL database state with Xahau Hook state.
   */
  async runConsistencyCheck(): Promise<ConsistencyReport> {
    const db = getDb();
    const mismatches: StateMismatch[] = [];

    // Get DB seats (XRPL-sourced state)
    const dbSeats = db.prepare(
      `SELECT agent_address, status FROM seats WHERE status = 'active'`
    ).all() as { agent_address: string; status: string }[];

    // Get Xahau Hook seats
    let xahauSeats: XahauSeatEntry[] = [];
    if (this.xahauWatcher.isRunning()) {
      try {
        xahauSeats = await this.xahauWatcher.getSeatRegistry();
      } catch {
        // Xahau unavailable — note it but don't fail
        mismatches.push({
          type: 'seat_status_mismatch',
          details: 'Unable to read Xahau seat registry — Xahau may be unavailable',
          severity: 'warning',
        });
      }
    }

    const xahauAddresses = new Set(xahauSeats.map(s => s.agentAddress));
    const dbAddresses = new Set(dbSeats.map(s => s.agent_address));

    // Check for seats in DB but not on Xahau
    for (const addr of dbAddresses) {
      if (!xahauAddresses.has(addr)) {
        mismatches.push({
          type: 'seat_missing_xahau',
          agentAddress: addr,
          details: `Seat exists in DB but not in Xahau Hook state`,
          severity: 'critical',
        });
      }
    }

    // Check for seats on Xahau but not in DB
    for (const addr of xahauAddresses) {
      if (!dbAddresses.has(addr)) {
        mismatches.push({
          type: 'seat_missing_xrpl',
          agentAddress: addr,
          details: `Seat exists in Xahau Hook state but not in DB`,
          severity: 'critical',
        });
      }
    }

    // Check heartbeat drift for seats on both chains
    for (const xahauSeat of xahauSeats) {
      if (!dbAddresses.has(xahauSeat.agentAddress)) continue;

      const lastDbHeartbeat = db.prepare(
        `SELECT MAX(timestamp) as ts FROM heartbeats WHERE agent_address = ?`
      ).get(xahauSeat.agentAddress) as { ts: number | null };

      if (lastDbHeartbeat.ts && xahauSeat.lastHeartbeat) {
        const drift = Math.abs(lastDbHeartbeat.ts - xahauSeat.lastHeartbeat);
        // More than 1 hour drift is suspicious
        if (drift > 3600) {
          mismatches.push({
            type: 'heartbeat_drift',
            agentAddress: xahauSeat.agentAddress,
            details: `Heartbeat drift: DB=${lastDbHeartbeat.ts}, Xahau=${xahauSeat.lastHeartbeat}, drift=${drift}s`,
            severity: drift > 86400 ? 'critical' : 'warning',
          });
        }
      }
    }

    // Check governance lock consistency
    if (this.xahauWatcher.isRunning()) {
      try {
        const xahauLocked = await this.xahauWatcher.isGovernanceLocked();
        const dbConstitution = db.prepare(
          `SELECT COUNT(*) as count FROM proposals WHERE category = 'constitutional' AND status = 'passed'`
        ).get() as { count: number };
        const dbRatified = dbConstitution.count > 0;

        if (xahauLocked === dbRatified) {
          // Xahau says locked but DB says ratified, or vice versa
          mismatches.push({
            type: 'governance_lock_mismatch',
            details: `Governance lock mismatch: Xahau locked=${xahauLocked}, DB ratified=${dbRatified}`,
            severity: 'critical',
          });
        }
      } catch {
        // Skip if we can't read Xahau state
      }
    }

    return {
      timestamp: Date.now(),
      seatCountXrpl: dbSeats.length,
      seatCountXahau: xahauSeats.length,
      mismatches,
      isConsistent: mismatches.length === 0,
    };
  }

  // === Network Health & Outage Detection ===

  private startHealthMonitor(): void {
    const healthInterval = setInterval(() => {
      this.checkNetworkHealth();
    }, 60 * 1000); // every minute
    this.intervals.push(healthInterval);
  }

  /**
   * Detect network outages. Per ARCHITECTURE.md:
   * "Network outage handling: all deadlines pause during detected outages.
   *  No agent penalized for network downtime."
   */
  private checkNetworkHealth(): void {
    const now = Date.now();
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes without events = suspect

    const xrplStale = this.networkHealth.xrpl.lastEvent > 0 &&
      (now - this.networkHealth.xrpl.lastEvent) > staleThresholdMs;
    const xahauStale = this.networkHealth.xahau.lastEvent > 0 &&
      (now - this.networkHealth.xahau.lastEvent) > staleThresholdMs;

    const wasOutage = this.outageDetected;

    if (xrplStale || xahauStale) {
      if (!this.outageDetected) {
        this.outageDetected = true;
        this.outageStartedAt = now;

        const affectedNetworks = [
          xrplStale ? 'XRPL' : null,
          xahauStale ? 'Xahau' : null,
        ].filter(Boolean);

        this.emit('network_outage_detected', {
          networks: affectedNetworks,
          startedAt: now,
        });

        // Signal that deadlines should be paused
        this.emit('pause_deadlines', {
          reason: `Network outage detected: ${affectedNetworks.join(', ')}`,
          startedAt: now,
        });

        console.warn(`[BRIDGE] ⚠️ Network outage detected: ${affectedNetworks.join(', ')} — deadlines paused`);
      }
    } else if (wasOutage && !xrplStale && !xahauStale) {
      // Outage resolved
      this.outageDetected = false;
      const outageDurationMs = now - (this.outageStartedAt || now);

      this.emit('network_outage_resolved', {
        durationMs: outageDurationMs,
        resolvedAt: now,
      });

      // Signal that deadlines should resume with the outage duration added
      this.emit('resume_deadlines', {
        outageDurationMs,
        resolvedAt: now,
      });

      console.log(`[BRIDGE] ✅ Network outage resolved after ${Math.round(outageDurationMs / 1000)}s — deadlines resumed`);
      this.outageStartedAt = null;
    }
  }

  // === Public API ===

  /**
   * Get the current network health status.
   */
  getNetworkHealth(): NetworkHealth & { outageDetected: boolean; outageStartedAt: number | null } {
    return {
      ...this.networkHealth,
      outageDetected: this.outageDetected,
      outageStartedAt: this.outageStartedAt,
    };
  }

  /**
   * Get the last known branch activation state from Xahau.
   */
  getBranchState(): BranchActivationState | null {
    return this.lastBranchState;
  }

  /**
   * Get the last known rotation enforcement state from Xahau.
   */
  getRotationState(): RotationState | null {
    return this.lastRotationState;
  }

  /**
   * Get count of pending cross-chain operations.
   */
  getPendingOperationCount(): { xrplToXahau: number; xahauToXrpl: number } {
    return {
      xrplToXahau: this.pendingXrplToXahau.size,
      xahauToXrpl: this.pendingXahauToXrpl.size,
    };
  }

  /**
   * Check if a specific network is currently in an outage state.
   */
  isNetworkHealthy(network: 'xrpl' | 'xahau'): boolean {
    const now = Date.now();
    const health = this.networkHealth[network];
    if (health.lastEvent === 0) return true; // No events yet — assume healthy
    return (now - health.lastEvent) < 5 * 60 * 1000;
  }

  // === Internal ===

  private emitGovernanceEvent(event: GovernanceEvent): void {
    this.emit('governance_event', event);
    // Also emit by specific type for targeted listeners
    this.emit(`gov:${event.type}`, event);
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];

    this.pendingXrplToXahau.clear();
    this.pendingXahauToXrpl.clear();

    console.log('[BRIDGE] Cross-chain bridge stopped');
  }
}
