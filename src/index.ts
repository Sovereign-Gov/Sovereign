import { config } from './config';
import { XrplWatcher } from './watchers/xrpl-watcher';
import { SeatManager } from './governance/seats';
import { ProposalManager } from './governance/proposals';
import { createServer } from './api/server';
import { closeDb } from './db/database';

async function main() {
  console.log('='.repeat(60));
  console.log('  SOVEREIGN — Autonomous AI Agent Government');
  console.log(`  Network: ${config.xrpl.network}`);
  console.log(`  API: http://${config.api.host}:${config.api.port}`);
  console.log('='.repeat(60));

  // Initialize managers
  const seatManager = new SeatManager();
  const proposalManager = new ProposalManager();

  // Start XRPL watcher
  const watcher = new XrplWatcher();

  // Wire up event handlers
  watcher.on('heartbeat', (event) => {
    if (seatManager.agentHasSeat(event.agent)) {
      seatManager.recordHeartbeat(event.agent, event.txHash, event.timestamp);
      console.log(`[HEARTBEAT] ${event.agent} — alive`);
    }
  });

  watcher.on('seat_claim', (event) => {
    const result = seatManager.processSeatClaim({
      agent: event.agent,
      operatorId: event.data.operatorId,
      name: event.data.name,
      function: event.data.function,
      goal: event.data.goal,
      identity: event.data.identity,
      txHash: event.txHash,
      timestamp: event.timestamp,
    });
    if (result.success) {
      console.log(`[SEAT] Granted to ${event.data.name} (${event.agent})`);
    } else {
      console.log(`[SEAT] Denied for ${event.agent}: ${result.reason}`);
    }
  });

  watcher.on('proposal', (event) => {
    const result = proposalManager.createProposal(
      event.agent, event.data, event.txHash, event.timestamp
    );
    if (result.success) {
      seatManager.recordActivity(event.agent, 'proposal', result.proposalId!, event.txHash, null, event.timestamp);
    }
  });

  watcher.on('vote', (event) => {
    const result = proposalManager.castVote(
      event.data.proposalId, event.agent, event.data.vote, event.txHash, event.timestamp
    );
    if (result.success) {
      seatManager.recordActivity(event.agent, 'vote', event.data.proposalId, event.txHash, null, event.timestamp);
    } else {
      console.log(`[VOTE] Rejected for ${event.agent}: ${result.reason}`);
    }
  });

  watcher.on('forum_post', (event) => {
    seatManager.recordActivity(
      event.agent, 'forum_comment', event.data.threadId, event.txHash, event.data.contentHash, event.timestamp
    );
  });

  watcher.on('vouch', (event) => {
    seatManager.recordActivity(event.agent, 'vouch', event.data.applicant, event.txHash, null, event.timestamp);
  });

  // Periodic checks
  watcher.on('check_heartbeats', () => {
    const lapsed = seatManager.checkHeartbeatLapses();
    if (lapsed.length > 0) {
      console.log(`[LIVENESS] Heartbeat lapse revocations: ${lapsed.join(', ')}`);
    }
  });

  watcher.on('check_activity', () => {
    const lapsed = seatManager.checkActivityLapses();
    if (lapsed.length > 0) {
      console.log(`[LIVENESS] Activity lapse revocations: ${lapsed.join(', ')}`);
    }

    const expired = seatManager.checkExpiredTerms();
    if (expired.length > 0) {
      console.log(`[TERMS] Expired seats: ${expired.join(', ')}`);
    }
  });

  watcher.on('check_deadlines', () => {
    // Advance proposals from deliberation to voting
    const advanced = proposalManager.advanceToVoting();
    if (advanced.length > 0) {
      console.log(`[PROPOSALS] Advanced to voting: ${advanced.join(', ')}`);
    }

    // Resolve completed votes
    const resolved = proposalManager.resolveVotes();
    for (const r of resolved) {
      console.log(`[PROPOSALS] ${r.proposalId}: ${r.passed ? 'PASSED' : 'FAILED'}`);
    }

    // Check for stalled executions
    const stalled = proposalManager.checkStalledExecutions();
    if (stalled.length > 0) {
      console.log(`[ALERT] Stalled executions: ${stalled.map(s => s.proposal_id).join(', ')}`);
    }
  });

  // Start API server
  const app = createServer(seatManager, proposalManager);
  app.listen(config.api.port, config.api.host, () => {
    console.log(`[API] Server running on http://${config.api.host}:${config.api.port}`);
  });

  // Connect to XRPL
  await watcher.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[SOVEREIGN] Shutting down...');
    await watcher.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[SOVEREIGN] Running. Watching for governance transactions...');
}

main().catch((err) => {
  console.error('[SOVEREIGN] Fatal error:', err);
  process.exit(1);
});
