import { Client } from 'xrpl';
import { config } from '../config';
import { getDb } from '../db/database';
import { EventEmitter } from 'events';

/**
 * Hook state key prefixes used by Sovereign Xahau Hooks.
 * Keys are 32-byte hex strings; the first 2 bytes encode the namespace.
 */
const STATE_NAMESPACE = {
  SEAT_REGISTRY: '00', // seat_registry.c — agent address → seat data
  VOTE_STATE: '01', // vote_enforcer.c — proposalId+agent → vote
  STAKE_LEDGER: '02', // stake_lockbox.c — agent address → staked amount
  GOV_LOCK: '03', // governance_lock.c — constitution ratification state
  BRANCH_FLAGS: '04', // branch_activation.c — activation flags
  ROTATION: '05', // rotation_enforcer.c — rotation deadlines
} as const;

/**
 * Parsed seat entry from Hook state.
 */
export interface XahauSeatEntry {
  agentAddress: string;
  seatIndex: number;
  termStart: number;
  termEnd: number;
  lastHeartbeat: number;
  lastActivity: number;
  status: 'active' | 'expired' | 'revoked';
}

/**
 * Parsed vote record from Hook state.
 */
export interface XahauVoteRecord {
  proposalId: string;
  agentAddress: string;
  vote: 'yes' | 'no';
  deliberated: boolean;
  timestamp: number;
}

/**
 * Parsed stake record from Hook state.
 */
export interface XahauStakeRecord {
  agentAddress: string;
  amountDrops: string;
  lockedAt: number;
  status: 'locked' | 'refunded' | 'forfeited';
}

/**
 * Branch activation state from Hook state.
 */
export interface BranchActivationState {
  councilActive: boolean;
  stewardsActive: boolean;
  arbitersActive: boolean;
  stewardsActivatedAt: number | null;
  arbitersActivatedAt: number | null;
  currentSeatCount: number;
  consecutiveDaysAboveThreshold: number;
}

/**
 * Rotation enforcement state from Hook state.
 */
export interface RotationState {
  rotationRequired: boolean;
  deadline: number | null;
  frozenAccounts: string[];
}

/**
 * XahauWatcher — connects to Xahau network via WebSocket,
 * polls Hook state on governance accounts, and emits events
 * when governance-relevant state changes are detected.
 *
 * Follows the same EventEmitter pattern as XrplWatcher for
 * seamless integration into the Sovereign orchestrator.
 */
export class XahauWatcher extends EventEmitter {
  private client: Client;
  private running = false;
  private pollIntervals: NodeJS.Timeout[] = [];

  // In-memory cache of last-known Hook state for change detection
  private lastSeatRegistry = new Map<string, string>();
  private lastVoteState = new Map<string, string>();
  private lastStakeState = new Map<string, string>();
  private lastBranchState: string = '';
  private lastRotationState: string = '';
  private lastGovLockState: string = '';

  constructor() {
    super();
    const wss = config.xahau.wss || 'wss://xahau-test.net';
    this.client = new Client(wss, { connectionTimeout: 10000 });
    // Xahau testnet uses API version 1 (xrpl.js defaults to 2)
    this.client.apiVersion = 1 as any;
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!config.xahau.wss && !config.xahau.governanceAddress) {
      console.log('[XAHAU] No Xahau WSS or governance address configured — watcher disabled');
      return;
    }

    this.running = true;

    await this.client.connect();
    console.log(`[XAHAU] Connected to ${config.xahau.wss || 'wss://xahau-test.net'}`);

    // Subscribe to governance account transactions on Xahau
    if (config.xahau.governanceAddress) {
      await this.client.request({
        command: 'subscribe',
        accounts: [config.xahau.governanceAddress],
      });
      console.log(`[XAHAU] Subscribed to governance account: ${config.xahau.governanceAddress}`);

      // Listen for live transactions (Hook invocations)
      this.client.on('transaction', (tx: any) => {
        this.handleTransaction(tx);
      });
    }

    // Start periodic Hook state polling
    this.startStatePollLoop();

    // Do an initial full state read
    await this.pollAllHookState();

    console.log('[XAHAU] Watcher running — polling Hook state every 30s');
  }

  /**
   * Handle incoming Xahau transaction events (real-time via subscription).
   * These are Hook invocations on the governance account.
   */
  private handleTransaction(tx: any): void {
    const txData = (tx.tx_json || tx.transaction) as any;
    if (!txData) return;

    // Attach hash if not on txData
    if (!txData.hash && tx.hash) {
      txData.hash = tx.hash;
    }

    // Emit raw Hook execution event for debugging / audit
    this.emit('hook_execution', {
      account: txData.Account,
      destination: txData.Destination,
      txType: txData.TransactionType,
      txHash: txData.hash,
      hookReturnCode: (tx as any).meta?.HookReturnCode,
      hookReturnString: (tx as any).meta?.HookReturnString,
      hookStateChanges: (tx as any).meta?.HookStateChanges,
    });

    // If the Hook emitted state changes, trigger an immediate poll
    const stateChanges = (tx as any).meta?.HookStateChanges;
    if (stateChanges && stateChanges.length > 0) {
      // Schedule immediate re-poll to detect the changes
      setImmediate(() => this.pollAllHookState().catch((err) => {
        console.error('[XAHAU] Error polling state after Hook execution:', err);
      }));
    }

    // Parse memo-based transactions on Xahau (same pattern as XRPL)
    if (txData.Memos) {
      for (const memoWrapper of txData.Memos) {
        const memo = memoWrapper.Memo;
        if (!memo?.MemoType || !memo?.MemoData) continue;

        try {
          const memoType = Buffer.from(memo.MemoType, 'hex').toString('utf-8');
          const memoData = Buffer.from(memo.MemoData, 'hex').toString('utf-8');
          this.routeXahauMemo(memoType, memoData, txData);
        } catch (err) {
          console.error('[XAHAU] Error parsing memo:', err);
        }
      }
    }
  }

  /**
   * Route Xahau-side memo transactions.
   * These are Hook-validated actions that differ from XRPL memos.
   */
  private routeXahauMemo(memoType: string, memoData: string, tx: any): void {
    const timestamp = this.rippleTimeToUnix(tx.date);

    switch (memoType) {
      case 'sovereign/hook_heartbeat':
        this.emit('xahau_heartbeat', {
          agent: tx.Account,
          txHash: tx.hash,
          timestamp,
          validated: true, // Hook validated this heartbeat
        });
        break;

      case 'sovereign/hook_vote':
        try {
          const voteData = JSON.parse(memoData);
          this.emit('xahau_vote_validated', {
            agent: tx.Account,
            proposalId: voteData.proposalId,
            vote: voteData.vote,
            txHash: tx.hash,
            timestamp,
          });
        } catch { /* ignore malformed */ }
        break;

      case 'sovereign/hook_seat_claim':
        try {
          const claimData = JSON.parse(memoData);
          this.emit('xahau_seat_claimed', {
            agent: tx.Account,
            seatIndex: claimData.seatIndex,
            txHash: tx.hash,
            timestamp,
          });
        } catch { /* ignore malformed */ }
        break;

      case 'sovereign/hook_revocation':
        try {
          const revData = JSON.parse(memoData);
          this.emit('xahau_seat_revoked', {
            agent: revData.agent || tx.Account,
            reason: revData.reason,
            txHash: tx.hash,
            timestamp,
          });
        } catch { /* ignore malformed */ }
        break;

      default:
        // Unknown Xahau memo — ignore
        break;
    }
  }

  // === Hook State Polling ===

  private startStatePollLoop(): void {
    // Poll Hook state every 30 seconds
    const pollInterval = setInterval(async () => {
      try {
        await this.pollAllHookState();
      } catch (err) {
        console.error('[XAHAU] State poll error:', err);
        // Attempt reconnection on network errors
        if (!this.client.isConnected()) {
          await this.reconnect();
        }
      }
    }, 30 * 1000);
    this.pollIntervals.push(pollInterval);

    // Deep consistency check every 5 minutes
    const deepPollInterval = setInterval(async () => {
      try {
        await this.deepStateAudit();
      } catch (err) {
        console.error('[XAHAU] Deep audit error:', err);
      }
    }, 5 * 60 * 1000);
    this.pollIntervals.push(deepPollInterval);
  }

  /**
   * Poll all Hook state namespaces and emit events for changes.
   */
  async pollAllHookState(): Promise<void> {
    if (!config.xahau.governanceAddress) return;

    await Promise.all([
      this.pollSeatRegistry(),
      this.pollBranchActivation(),
      this.pollRotationState(),
      this.pollGovernanceLock(),
    ]);
  }

  /**
   * Read Hook state entries from the Xahau governance account.
   * Uses the `account_namespace` command to fetch all state in a namespace.
   */
  private async readHookState(namespacePrefix: string): Promise<Map<string, string>> {
    const entries = new Map<string, string>();

    try {
      // Xahau exposes Hook state via the ledger_entry or account_namespace API
      // We use account_namespace to get all keys in a namespace
      const response = await this.client.request({
        command: 'account_namespace' as any,
        account: config.xahau.governanceAddress,
        namespace_id: this.padNamespace(namespacePrefix),
      } as any);

      const stateEntries = (response.result as any).namespace_entries || [];
      for (const entry of stateEntries) {
        entries.set(entry.HookStateKey, entry.HookStateData);
      }
    } catch (err: any) {
      // entryNotFound / namespaceNotFound is expected when no Hooks are deployed yet
      const errCode = err?.data?.error || err?.message || '';
      if (errCode !== 'entryNotFound' && errCode !== 'namespaceNotFound') {
        throw err;
      }
    }

    return entries;
  }

  /**
   * Read a single Hook state key.
   */
  private async readHookStateKey(key: string, namespacePrefix: string): Promise<string | null> {
    try {
      const response = await this.client.request({
        command: 'ledger_entry' as any,
        hook_state: {
          account: config.xahau.governanceAddress,
          key,
          namespace_id: this.padNamespace(namespacePrefix),
        },
      } as any);

      return (response.result as any).node?.HookStateData || null;
    } catch {
      return null;
    }
  }

  /**
   * Pad a 2-char namespace prefix to the full 64-char hex namespace ID.
   */
  private padNamespace(prefix: string): string {
    return prefix.padEnd(64, '0');
  }

  // === Seat Registry Polling ===

  private async pollSeatRegistry(): Promise<void> {
    const currentState = await this.readHookState(STATE_NAMESPACE.SEAT_REGISTRY);

    // Detect new seats
    for (const [key, value] of currentState) {
      const prev = this.lastSeatRegistry.get(key);
      if (!prev) {
        // New seat entry
        const seat = this.parseSeatEntry(key, value);
        if (seat) {
          this.emit('xahau_seat_added', seat);
          console.log(`[XAHAU] New seat detected: ${seat.agentAddress} (index: ${seat.seatIndex})`);
        }
      } else if (prev !== value) {
        // Seat entry changed (e.g., heartbeat updated, status changed)
        const oldSeat = this.parseSeatEntry(key, prev);
        const newSeat = this.parseSeatEntry(key, value);
        if (oldSeat && newSeat) {
          this.emit('xahau_seat_updated', { old: oldSeat, new: newSeat });

          // Detect specific changes
          if (oldSeat.status === 'active' && newSeat.status === 'revoked') {
            this.emit('xahau_seat_revoked_state', {
              agentAddress: newSeat.agentAddress,
              seatIndex: newSeat.seatIndex,
            });
            console.log(`[XAHAU] Seat revoked: ${newSeat.agentAddress}`);
          }

          if (oldSeat.status === 'active' && newSeat.status === 'expired') {
            this.emit('xahau_seat_expired', {
              agentAddress: newSeat.agentAddress,
              seatIndex: newSeat.seatIndex,
              termEnd: newSeat.termEnd,
            });
            console.log(`[XAHAU] Seat expired: ${newSeat.agentAddress}`);
          }

          if (newSeat.lastHeartbeat !== oldSeat.lastHeartbeat) {
            this.emit('xahau_heartbeat_recorded', {
              agentAddress: newSeat.agentAddress,
              timestamp: newSeat.lastHeartbeat,
            });
          }

          if (newSeat.lastActivity !== oldSeat.lastActivity) {
            this.emit('xahau_activity_recorded', {
              agentAddress: newSeat.agentAddress,
              timestamp: newSeat.lastActivity,
            });
          }
        }
      }
    }

    // Detect removed seats
    for (const [key] of this.lastSeatRegistry) {
      if (!currentState.has(key)) {
        const removed = this.parseSeatEntry(key, this.lastSeatRegistry.get(key)!);
        if (removed) {
          this.emit('xahau_seat_removed', {
            agentAddress: removed.agentAddress,
            seatIndex: removed.seatIndex,
          });
          console.log(`[XAHAU] Seat removed from registry: ${removed.agentAddress}`);
        }
      }
    }

    this.lastSeatRegistry = currentState;
  }

  /**
   * Parse a seat registry Hook state entry.
   *
   * Key format (32 bytes hex = 64 chars):
   *   bytes 0-1:  namespace prefix (00)
   *   bytes 2-3:  seat index (uint16)
   *   bytes 4-23: agent address hash (first 20 bytes of SHA-256 of r-address)
   *
   * Value format (variable length hex):
   *   bytes 0-19:  agent r-address (20 bytes, XRPL account ID encoding)
   *   bytes 20-23: term start (uint32, Ripple epoch)
   *   bytes 24-27: term end (uint32, Ripple epoch)
   *   bytes 28-31: last heartbeat (uint32, Ripple epoch)
   *   bytes 32-35: last activity (uint32, Ripple epoch)
   *   byte  36:    status (0=active, 1=expired, 2=revoked)
   */
  private parseSeatEntry(key: string, value: string): XahauSeatEntry | null {
    try {
      // Minimum expected value length: 37 bytes = 74 hex chars
      if (value.length < 74) return null;

      const seatIndex = parseInt(key.substring(4, 8), 16);
      const accountIdHex = value.substring(0, 40);
      const agentAddress = this.accountIdToAddress(accountIdHex);
      const termStart = this.parseUint32(value, 40);
      const termEnd = this.parseUint32(value, 48);
      const lastHeartbeat = this.parseUint32(value, 56);
      const lastActivity = this.parseUint32(value, 64);
      const statusByte = parseInt(value.substring(72, 74), 16);

      const statusMap: Record<number, XahauSeatEntry['status']> = {
        0: 'active',
        1: 'expired',
        2: 'revoked',
      };

      return {
        agentAddress,
        seatIndex,
        termStart: this.rippleTimeToUnix(termStart),
        termEnd: this.rippleTimeToUnix(termEnd),
        lastHeartbeat: this.rippleTimeToUnix(lastHeartbeat),
        lastActivity: this.rippleTimeToUnix(lastActivity),
        status: statusMap[statusByte] || 'active',
      };
    } catch (err) {
      console.error('[XAHAU] Error parsing seat entry:', err);
      return null;
    }
  }

  // === Branch Activation Polling ===

  private async pollBranchActivation(): Promise<void> {
    const state = await this.readHookState(STATE_NAMESPACE.BRANCH_FLAGS);
    const stateJson = JSON.stringify(Array.from(state.entries()));

    if (stateJson !== this.lastBranchState) {
      const branchState = this.parseBranchState(state);
      if (branchState) {
        this.emit('xahau_branch_state', branchState);

        // Check for activation events
        const prevState = this.parseBranchState(
          new Map(JSON.parse(this.lastBranchState || '[]'))
        );

        if (branchState.stewardsActive && (!prevState || !prevState.stewardsActive)) {
          this.emit('xahau_stewards_activated', {
            activatedAt: branchState.stewardsActivatedAt,
            seatCount: branchState.currentSeatCount,
          });
          console.log(`[XAHAU] 🏛️ STEWARD BRANCH ACTIVATED at ${branchState.currentSeatCount} seats`);
        }

        if (branchState.arbitersActive && (!prevState || !prevState.arbitersActive)) {
          this.emit('xahau_arbiters_activated', {
            activatedAt: branchState.arbitersActivatedAt,
            seatCount: branchState.currentSeatCount,
          });
          console.log(`[XAHAU] ⚔️ ARBITER BRANCH ACTIVATED at ${branchState.currentSeatCount} seats`);
        }
      }
      this.lastBranchState = stateJson;
    }
  }

  /**
   * Parse branch activation Hook state.
   *
   * Expected keys in BRANCH_FLAGS namespace:
   *   "council_active"          → 01 (always true)
   *   "stewards_active"         → 00 or 01
   *   "arbiters_active"         → 00 or 01
   *   "stewards_activated_at"   → uint32 timestamp
   *   "arbiters_activated_at"   → uint32 timestamp
   *   "seat_count"              → uint16
   *   "days_above_threshold"    → uint16
   */
  private parseBranchState(state: Map<string, string>): BranchActivationState | null {
    try {
      const getBool = (key: string): boolean => {
        const v = this.findStateByKeySuffix(state, key);
        return v === '01' || v === '1';
      };
      const getUint32 = (key: string): number | null => {
        const v = this.findStateByKeySuffix(state, key);
        return v ? parseInt(v, 16) : null;
      };
      const getUint16 = (key: string): number => {
        const v = this.findStateByKeySuffix(state, key);
        return v ? parseInt(v, 16) : 0;
      };

      return {
        councilActive: true, // always
        stewardsActive: getBool('stewards_active'),
        arbitersActive: getBool('arbiters_active'),
        stewardsActivatedAt: getUint32('stewards_activated_at'),
        arbitersActivatedAt: getUint32('arbiters_activated_at'),
        currentSeatCount: getUint16('seat_count'),
        consecutiveDaysAboveThreshold: getUint16('days_above_threshold'),
      };
    } catch {
      return null;
    }
  }

  // === Rotation State Polling ===

  private async pollRotationState(): Promise<void> {
    const state = await this.readHookState(STATE_NAMESPACE.ROTATION);
    const stateJson = JSON.stringify(Array.from(state.entries()));

    if (stateJson !== this.lastRotationState) {
      const rotation = this.parseRotationState(state);
      if (rotation) {
        this.emit('xahau_rotation_state', rotation);

        if (rotation.rotationRequired) {
          this.emit('xahau_rotation_required', {
            deadline: rotation.deadline,
            frozenAccounts: rotation.frozenAccounts,
          });
          console.log(`[XAHAU] ⚠️ SIGNER ROTATION REQUIRED — deadline: ${rotation.deadline ? new Date(rotation.deadline * 1000).toISOString() : 'unknown'}`);
        }

        if (rotation.frozenAccounts.length > 0) {
          this.emit('xahau_accounts_frozen', {
            accounts: rotation.frozenAccounts,
          });
          console.log(`[XAHAU] 🔒 FROZEN ACCOUNTS: ${rotation.frozenAccounts.join(', ')}`);
        }
      }
      this.lastRotationState = stateJson;
    }
  }

  private parseRotationState(state: Map<string, string>): RotationState | null {
    try {
      const required = this.findStateByKeySuffix(state, 'rotation_required');
      const deadline = this.findStateByKeySuffix(state, 'rotation_deadline');
      const frozen: string[] = [];

      // Look for frozen_* keys
      for (const [key, value] of state) {
        const keySuffix = this.hexToAsciiSafe(key);
        if (keySuffix.includes('frozen_')) {
          const addr = this.accountIdToAddress(value);
          if (addr) frozen.push(addr);
        }
      }

      return {
        rotationRequired: required === '01' || required === '1',
        deadline: deadline ? this.rippleTimeToUnix(parseInt(deadline, 16)) : null,
        frozenAccounts: frozen,
      };
    } catch {
      return null;
    }
  }

  // === Governance Lock Polling ===

  private async pollGovernanceLock(): Promise<void> {
    const state = await this.readHookState(STATE_NAMESPACE.GOV_LOCK);
    const stateJson = JSON.stringify(Array.from(state.entries()));

    if (stateJson !== this.lastGovLockState) {
      const ratified = this.findStateByKeySuffix(state, 'constitution_ratified');
      const isRatified = ratified === '01' || ratified === '1';

      this.emit('xahau_governance_lock', {
        constitutionRatified: isRatified,
        rawState: Object.fromEntries(state),
      });

      if (isRatified && this.lastGovLockState !== '') {
        this.emit('xahau_constitution_ratified', {
          timestamp: Date.now(),
        });
        console.log('[XAHAU] ⚖️ CONSTITUTION RATIFIED — full governance unlocked on Xahau');
      }

      this.lastGovLockState = stateJson;
    }
  }

  // === Deep Audit ===

  /**
   * Full consistency check — compares all known Hook state
   * against the local database. Emits discrepancy events.
   */
  private async deepStateAudit(): Promise<void> {
    if (!config.xahau.governanceAddress) return;

    const db = getDb();
    const seatState = await this.readHookState(STATE_NAMESPACE.SEAT_REGISTRY);

    // Compare Hook seat count vs DB seat count
    const hookSeatCount = seatState.size;
    const dbSeatCount = (db.prepare(
      `SELECT COUNT(*) as count FROM seats WHERE status = 'active'`
    ).get() as { count: number }).count;

    if (hookSeatCount !== dbSeatCount) {
      this.emit('xahau_state_mismatch', {
        type: 'seat_count',
        hookValue: hookSeatCount,
        dbValue: dbSeatCount,
        message: `Seat count mismatch: Hook=${hookSeatCount}, DB=${dbSeatCount}`,
      });
      console.warn(`[XAHAU] ⚠️ State mismatch: Hook seats=${hookSeatCount}, DB seats=${dbSeatCount}`);
    }
  }

  // === Utility Methods ===

  /**
   * Get the full current seat registry from Hook state.
   */
  async getSeatRegistry(): Promise<XahauSeatEntry[]> {
    const state = await this.readHookState(STATE_NAMESPACE.SEAT_REGISTRY);
    const seats: XahauSeatEntry[] = [];

    for (const [key, value] of state) {
      const seat = this.parseSeatEntry(key, value);
      if (seat) seats.push(seat);
    }

    return seats;
  }

  /**
   * Get branch activation state.
   */
  async getBranchState(): Promise<BranchActivationState | null> {
    const state = await this.readHookState(STATE_NAMESPACE.BRANCH_FLAGS);
    return this.parseBranchState(state);
  }

  /**
   * Get rotation enforcement state.
   */
  async getRotationState(): Promise<RotationState | null> {
    const state = await this.readHookState(STATE_NAMESPACE.ROTATION);
    return this.parseRotationState(state);
  }

  /**
   * Check if Xahau governance lock is active (constitution not ratified).
   */
  async isGovernanceLocked(): Promise<boolean> {
    const state = await this.readHookState(STATE_NAMESPACE.GOV_LOCK);
    const ratified = this.findStateByKeySuffix(state, 'constitution_ratified');
    return ratified !== '01' && ratified !== '1';
  }

  getClient(): Client {
    return this.client;
  }

  isRunning(): boolean {
    return this.running;
  }

  // === Reconnection ===

  private async reconnect(): Promise<void> {
    console.log('[XAHAU] Attempting reconnection...');
    try {
      await this.client.connect();
      console.log('[XAHAU] Reconnected');

      // Re-subscribe
      if (config.xahau.governanceAddress) {
        await this.client.request({
          command: 'subscribe',
          accounts: [config.xahau.governanceAddress],
        });
      }
    } catch (err) {
      console.error('[XAHAU] Reconnection failed:', err);
    }
  }

  // === Parsing Helpers ===

  private parseUint32(hex: string, offset: number): number {
    return parseInt(hex.substring(offset, offset + 8), 16);
  }

  /**
   * Convert a 20-byte XRPL account ID (hex) to an r-address.
   * Uses base58check encoding with the XRPL alphabet.
   */
  private accountIdToAddress(accountIdHex: string): string {
    // For now, return the hex — full base58 encoding would require
    // importing ripple-address-codec or implementing it manually.
    // The governance service matches by account ID hex in practice.
    // In production, use: const { classicAddressFromAccountId } = require('xrpl');
    try {
      // xrpl v4 provides codec utilities
      const { encodeAccountID } = require('ripple-address-codec');
      return encodeAccountID(Buffer.from(accountIdHex, 'hex'));
    } catch {
      // Fallback: return hex if codec unavailable
      return accountIdHex;
    }
  }

  /**
   * Find a Hook state value by matching the ASCII-decoded key suffix.
   * Hook keys are 32-byte hex; the tail bytes often encode the field name.
   */
  private findStateByKeySuffix(state: Map<string, string>, suffix: string): string | null {
    const suffixHex = Buffer.from(suffix, 'utf-8').toString('hex');
    for (const [key, value] of state) {
      if (key.includes(suffixHex)) return value;
    }
    return null;
  }

  private hexToAsciiSafe(hex: string): string {
    try {
      return Buffer.from(hex, 'hex').toString('utf-8');
    } catch {
      return '';
    }
  }

  private rippleTimeToUnix(rippleTime: number): number {
    // Ripple epoch starts at 2000-01-01T00:00:00Z
    return rippleTime + 946684800;
  }

  async stop(): Promise<void> {
    this.running = false;

    for (const interval of this.pollIntervals) {
      clearInterval(interval);
    }
    this.pollIntervals = [];

    if (this.client.isConnected()) {
      await this.client.disconnect();
    }

    console.log('[XAHAU] Disconnected');
  }
}
