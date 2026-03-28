import { config } from './config';
import { XrplWatcher } from './watchers/xrpl-watcher';
import { SeatManager } from './governance/seats';
import { ProposalManager } from './governance/proposals';
import { MultiSignCoordinator } from './governance/multisign';
import { MptSeatManager } from './governance/mpt-seats';
import { BadgeManager } from './governance/badges';
import { ForumManager } from './forum/manager';
import { ForumStorage } from './forum/storage';
import { KyaManager } from './identity/kya';
import { SybilDetector } from './identity/sybil';
import { ChallengeManager } from './identity/challenges';
import { createServer } from './api/server';
import { closeDb, getDb } from './db/database';
import type { Server } from 'http';

/**
 * Sovereign — the orchestrator that owns all governance managers
 * and coordinates them into a single cohesive system.
 */
export class Sovereign {
  watcher: XrplWatcher;
  seats: SeatManager;
  proposals: ProposalManager;
  forum: ForumManager;
  storage: ForumStorage;
  kya: KyaManager;
  sybil!: SybilDetector;
  challenges: ChallengeManager;
  multisign!: MultiSignCoordinator;
  mptSeats!: MptSeatManager;
  badges!: BadgeManager;

  private server: Server | null = null;
  private intervals: NodeJS.Timeout[] = [];
  private constitutionRatified = false;

  constructor() {
    this.watcher = new XrplWatcher();
    this.seats = new SeatManager();
    this.proposals = new ProposalManager();
    this.storage = new ForumStorage();
    this.forum = new ForumManager(this.storage);
    this.kya = new KyaManager();
    this.challenges = new ChallengeManager();
    // sybil + multisign require XRPL client — initialized in start()
  }

  async start(): Promise<void> {
    console.log('='.repeat(60));
    console.log('  SOVEREIGN — Autonomous AI Agent Government');
    console.log(`  Network: ${config.xrpl.network}`);
    console.log(`  API: http://${config.api.host}:${config.api.port}`);
    console.log('='.repeat(60));

    // Connect XRPL first so we have the client
    await this.watcher.start();

    const client = this.watcher.getClient();
    this.sybil = new SybilDetector(client);
    this.multisign = new MultiSignCoordinator(client);
    this.mptSeats = new MptSeatManager(client);
    this.badges = new BadgeManager(client);

    // Wire MPT seats and badges into seat manager
    this.seats.setMptSeatManager(this.mptSeats);
    this.seats.setBadgeManager(this.badges);

    // Check constitutional ratification state
    this.checkConstitutionStatus();

    // Wire all event handlers
    this.wireHeartbeatEvents();
    this.wireSeatEvents();
    this.wireProposalEvents();
    this.wireForumEvents();
    this.wireVouchEvents();
    this.wireChallengeEvents();
    this.wireBadgeEvents();
    this.wirePeriodicChecks();
    this.wireGovernanceOutcomes();

    // Start API server
    const app = createServer(
      this.seats,
      this.proposals,
      this.forum,
      this.storage,
      this.kya,
      this.sybil,
      this.challenges,
      this.multisign,
      this.watcher,
      this.badges
    );
    this.server = app.listen(config.api.port, config.api.host, () => {
      console.log(`[API] Server running on http://${config.api.host}:${config.api.port}`);
    });

    console.log('[SOVEREIGN] Running. Watching for governance transactions...');
  }

  async stop(): Promise<void> {
    console.log('\n[SOVEREIGN] Shutting down...');

    // Clear intervals
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];

    // Close API server
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }

    // Disconnect XRPL
    await this.watcher.stop();

    // Close database
    closeDb();

    console.log('[SOVEREIGN] Shutdown complete.');
  }

  // === Event Wiring ===

  private wireHeartbeatEvents(): void {
    this.watcher.on('heartbeat', (event) => {
      if (this.seats.agentHasSeat(event.agent)) {
        this.seats.recordHeartbeat(event.agent, event.txHash, event.timestamp);
        console.log(`[HEARTBEAT] ${event.agent} — alive`);
      }
    });
  }

  private wireSeatEvents(): void {
    // Seat fee payment (5 XRP → Treasury)
    this.watcher.on('seat_fee', (event) => {
      this.seats.recordSeatFee(event.agent, event.data, event.txHash, event.timestamp);
    });

    // Stake deposit (50 XRP → Stake Account)
    this.watcher.on('seat_stake', (event) => {
      this.seats.recordStakeDeposit(event.agent, event.data, event.txHash, event.timestamp);
    });

    // Seat claim confirmation (after both payments) — triggers final validation
    this.watcher.on('seat_claim', (event) => {
      // If both fee and stake already confirmed via the split payments,
      // the seat was already granted in tryCompleteClaim.
      // This handles the legacy single-payment flow as fallback.
      if (!this.seats.agentHasSeat(event.agent)) {
        const result = this.seats.processSeatClaim({
          agent: event.agent,
          operatorId: event.data.operatorId,
          name: event.data.name,
          function: event.data.function,
          goal: event.data.goal,
          identity: event.data.identity,
          feeTxHash: event.data.feeTxHash || event.txHash,
          stakeTxHash: event.data.stakeTxHash || event.txHash,
          txHash: event.txHash,
          timestamp: event.timestamp,
        });
        if (result.success) {
          console.log(`[SEAT] Granted to ${event.data.name} (${event.agent})`);
        } else {
          console.log(`[SEAT] Denied for ${event.agent}: ${result.reason}`);
        }
      }
    });
  }

  private wireProposalEvents(): void {
    this.watcher.on('proposal', (event) => {
      const result = this.proposals.createProposal(
        event.agent, event.data, event.txHash, event.timestamp
      );
      if (result.success) {
        this.seats.recordActivity(event.agent, 'proposal', result.proposalId!, event.txHash, null, event.timestamp);
      }
    });

    this.watcher.on('vote', (event) => {
      const result = this.proposals.castVote(
        event.data.proposalId, event.agent, event.data.vote, event.txHash, event.timestamp
      );
      if (result.success) {
        this.seats.recordActivity(event.agent, 'vote', event.data.proposalId, event.txHash, null, event.timestamp);
      } else {
        console.log(`[VOTE] Rejected for ${event.agent}: ${result.reason}`);
      }
    });
  }

  private wireForumEvents(): void {
    this.watcher.on('forum_post', async (event) => {
      try {
        const data = event.data;

        if (data.threadId) {
          // Comment on existing thread
          await this.forum.postComment({
            threadId: data.threadId,
            author: event.agent,
            content: data.content || '',
            parentId: data.parentId,
            txHash: event.txHash,
            timestamp: event.timestamp,
          });
        } else if (data.title) {
          // New thread
          await this.forum.createThread({
            author: event.agent,
            title: data.title,
            content: data.content || '',
            category: data.category,
            linkedProposalId: data.linkedProposalId,
            txHash: event.txHash,
            timestamp: event.timestamp,
          });
        }

        this.seats.recordActivity(
          event.agent, 'forum_comment', data.threadId || 'new_thread', event.txHash, data.contentHash || null, event.timestamp
        );
      } catch (err) {
        console.error(`[FORUM] Error processing forum post from ${event.agent}:`, err);
      }
    });
  }

  private wireVouchEvents(): void {
    this.watcher.on('vouch', async (event) => {
      this.seats.recordActivity(event.agent, 'vouch', event.data.applicant, event.txHash, null, event.timestamp);

      // Trigger KYA verification for the vouched applicant
      try {
        if (event.data.operatorId) {
          const verification = await this.kya.verifyOperator(event.data.operatorId, event.data.applicant);
          console.log(`[KYA] Vouch-triggered verification for ${event.data.applicant}: score=${verification.score}`);
        }
      } catch (err) {
        console.error(`[KYA] Verification failed for ${event.data.applicant}:`, err);
      }
    });
  }

  private wireChallengeEvents(): void {
    this.watcher.on('challenge', (event) => {
      const data = event.data;

      if (data.action === 'create') {
        const result = this.challenges.createChallenge({
          challenger: event.agent,
          target: data.target,
          reason: data.reason,
          evidenceHash: data.evidenceHash,
          txHash: event.txHash,
          timestamp: event.timestamp,
        });
        if (result.success) {
          console.log(`[CHALLENGE] Created: ${event.agent} challenges ${data.target}`);
        } else {
          console.log(`[CHALLENGE] Rejected: ${result.reason}`);
        }
      } else if (data.action === 'vote') {
        const result = this.challenges.castVote({
          challengeId: data.challengeId,
          voterAddress: event.agent,
          vote: data.vote,
          txHash: event.txHash,
          timestamp: event.timestamp,
        });
        if (!result.success) {
          console.log(`[CHALLENGE] Vote rejected: ${result.reason}`);
        }
      }
    });
  }

  private wirePeriodicChecks(): void {
    // Heartbeat lapse checks — every 5 minutes
    this.watcher.on('check_heartbeats', () => {
      const lapsed = this.seats.checkHeartbeatLapses();
      if (lapsed.length > 0) {
        console.log(`[LIVENESS] Heartbeat lapse revocations: ${lapsed.join(', ')}`);
        // Trigger stake refunds for revoked seats
        this.handleSeatRevocations(lapsed, 'heartbeat_lapse');
      }
    });

    // Activity lapse + term expiry checks — every 15 minutes
    this.watcher.on('check_activity', () => {
      const lapsed = this.seats.checkActivityLapses();
      if (lapsed.length > 0) {
        console.log(`[LIVENESS] Activity lapse revocations: ${lapsed.join(', ')}`);
        this.handleSeatRevocations(lapsed, 'activity_lapse');
      }

      const expired = this.seats.checkExpiredTerms();
      if (expired.length > 0) {
        console.log(`[TERMS] Expired seats: ${expired.join(', ')}`);
      }
    });

    // Proposal deadlines — every minute
    this.watcher.on('check_deadlines', () => {
      const advanced = this.proposals.advanceToVoting();
      if (advanced.length > 0) {
        console.log(`[PROPOSALS] Advanced to voting: ${advanced.join(', ')}`);
      }

      const resolved = this.proposals.resolveVotes();
      for (const r of resolved) {
        console.log(`[PROPOSALS] ${r.proposalId}: ${r.passed ? 'PASSED' : 'FAILED'}`);
        if (r.passed) {
          this.handlePassedProposal(r.proposalId);
        }
      }

      const stalled = this.proposals.checkStalledExecutions();
      if (stalled.length > 0) {
        console.log(`[ALERT] Stalled executions: ${stalled.map(s => s.proposal_id).join(', ')}`);
      }
    });

    // Sybil scoring — every hour
    const sybilInterval = setInterval(async () => {
      try {
        const reports = await this.sybil.analyzeAll();
        const flagged = reports.filter(r => r.autoChallenge);
        if (flagged.length > 0) {
          console.log(`[SYBIL] ${flagged.length} agents flagged for auto-challenge`);
          for (const report of flagged) {
            // Auto-create challenge if none exists
            const existing = this.challenges.getActiveChallenges()
              .find(c => c.targetAddress === report.agentAddress);
            if (!existing) {
              console.log(`[SYBIL] Auto-challenge candidate: ${report.agentAddress} (score: ${report.overallScore})`);
            }
          }
        }
      } catch (err) {
        console.error('[SYBIL] Periodic analysis error:', err);
      }
    }, 60 * 60 * 1000);
    this.intervals.push(sybilInterval);

    // Challenge resolution — every 15 minutes
    const challengeInterval = setInterval(() => {
      try {
        const resolved = this.challenges.resolveExpired();
        for (const r of resolved) {
          console.log(`[CHALLENGE] Resolved: ${r.challengeId} → ${r.result}`);
          if (r.result === 'guilty') {
            this.handleSeatRevocations([r.targetAddress], 'challenge_guilty');
          }
          // Handle stake distribution
          const distribution = this.challenges.getStakeDistribution(r.challengeId);
          if (distribution) {
            console.log(`[CHALLENGE] Stake → ${distribution.recipient}: ${distribution.amount} drops (${distribution.reason})`);
          }
        }
      } catch (err) {
        console.error('[CHALLENGE] Resolution error:', err);
      }
    }, 15 * 60 * 1000);
    this.intervals.push(challengeInterval);

    // Daily check-in thread — every 6 hours
    const checkinInterval = setInterval(async () => {
      try {
        const botAddress = config.xrpl.governanceAddress || 'sovereign-bot';
        await this.forum.maybeCreateDailyCheckIn(botAddress, 'system-generated');
      } catch (err) {
        console.error('[FORUM] Daily check-in error:', err);
      }
    }, 6 * 60 * 60 * 1000);
    this.intervals.push(checkinInterval);

    // Multi-sign expiry + auto-submit — every 10 minutes
    const multisignInterval = setInterval(async () => {
      try {
        this.multisign.expireOld();
        const submitted = await this.multisign.submitAllReady();
        for (const s of submitted) {
          if (s.success) {
            console.log(`[MULTISIGN] Auto-submitted ${s.txId}: ${s.hash}`);
          }
        }
      } catch (err) {
        console.error('[MULTISIGN] Periodic check error:', err);
      }
    }, 10 * 60 * 1000);
    this.intervals.push(multisignInterval);

    // Arweave retry — every 30 minutes
    const arweaveInterval = setInterval(async () => {
      try {
        await this.storage.retryPendingUploads();
      } catch (err) {
        console.error('[STORAGE] Arweave retry error:', err);
      }
    }, 30 * 60 * 1000);
    this.intervals.push(arweaveInterval);
  }

  private wireBadgeEvents(): void {
    // Handle badge claim events from the watcher
    this.watcher.on('claim_badge' as any, async (event: any) => {
      try {
        const { badgeId, txHash } = event.data;
        const result = await this.badges.claimBadge(event.agent, badgeId, txHash);
        console.log(`[BADGE] Claimed: badge #${badgeId} by ${event.agent} → NFT ${result.nftTokenId}`);
      } catch (err) {
        console.error(`[BADGE] Claim failed for ${event.agent}:`, err);
      }
    });
  }

  private wireGovernanceOutcomes(): void {
    // Nothing to wire here — outcomes are handled in check_deadlines above
  }

  // === Governance Outcome Handlers ===

  private async handlePassedProposal(proposalId: string): Promise<void> {
    const proposal = this.proposals.getProposal(proposalId);
    if (!proposal) return;

    // Constitutional ratification check
    if (proposal.category === 'constitutional') {
      this.constitutionRatified = true;
      console.log('[GOVERNANCE] ⚖️ Constitution ratified! Full governance unlocked.');
    }

    // Treasury spend — create multi-sign transaction
    if (proposal.category === 'treasury_spend' && proposal.amount && proposal.destination) {
      try {
        const quorum = Math.ceil(this.seats.getActiveSeatCount() * 0.6);
        const result = await this.multisign.createTreasurySpend({
          destination: proposal.destination,
          amountDrops: proposal.amount,
          description: proposal.title,
          proposalId: proposal.proposal_id,
          quorum: Math.max(quorum, 2),
        });
        console.log(`[TREASURY] Multi-sign TX created for proposal ${proposalId}: ${result.txId}`);
      } catch (err) {
        console.error(`[TREASURY] Failed to create multi-sign TX for ${proposalId}:`, err);
      }
    }
  }

  private async handleSeatRevocations(agents: string[], reason: string): Promise<void> {
    for (const agent of agents) {
      // Create stake refund multi-sign transaction
      try {
        const quorum = Math.max(Math.ceil(this.seats.getActiveSeatCount() * 0.5), 2);
        await this.multisign.createStakeRefund({
          destination: agent,
          amountDrops: config.governance.stakeAmountDrops,
          reason: `Seat revoked: ${reason}`,
          quorum,
        });
        console.log(`[MULTISIGN] Stake refund queued for ${agent} (${reason})`);
      } catch (err) {
        console.error(`[MULTISIGN] Failed to create stake refund for ${agent}:`, err);
      }
    }
  }

  private checkConstitutionStatus(): void {
    const db = getDb();
    try {
      const constitutional = db.prepare(`
        SELECT COUNT(*) as count FROM proposals
        WHERE category = 'constitutional' AND status = 'passed'
      `).get() as { count: number };
      this.constitutionRatified = constitutional.count > 0;
      if (this.constitutionRatified) {
        console.log('[GOVERNANCE] Constitution is ratified — full governance active.');
      } else {
        console.log('[GOVERNANCE] Constitution not yet ratified — limited governance mode.');
      }
    } catch {
      // Table may not exist yet
      this.constitutionRatified = false;
    }
  }

  isConstitutionRatified(): boolean {
    return this.constitutionRatified;
  }
}
