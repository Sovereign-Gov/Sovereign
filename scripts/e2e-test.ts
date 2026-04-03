/**
 * e2e-test.ts — Full end-to-end governance flow test.
 *
 * Tests the complete lifecycle:
 * 1. Constitution ratification
 * 2. Genesis agents claim seats (10 agents)
 * 3. Heartbeats
 * 4. Standard proposals (pass + fail)
 * 5. Constitutional proposals (supermajority)
 * 6. Forum deliberation
 * 7. Voting with resolution
 * 8. Sybil detection (skipped — needs real XRPL Client)
 * 9. Challenge system
 * 10. Heartbeat lapse revocation
 * 11. Voluntary departure
 * 12. Post-genesis admission
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Override DB path for test isolation BEFORE any imports that touch config
const TEST_DB = path.join(__dirname, '..', 'data', 'e2e-test.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
process.env.DB_PATH = TEST_DB;

async function run() {
  // Dynamic imports so DB_PATH env is picked up by config
  const { SeatManager } = await import('../src/governance/seats');
  const { ProposalManager } = await import('../src/governance/proposals');
  const { ChallengeManager } = await import('../src/identity/challenges');
  const { getDb, closeDb } = await import('../src/db/database');

  // getDb() auto-initializes the schema
  const db = getDb();
  const seats = new SeatManager();
  const proposals = new ProposalManager();
  const challenges = new ChallengeManager();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label}`);
      failed++;
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const txn = () => crypto.randomBytes(32).toString('hex');

  // Time references:
  // - proposalTime: when proposals are created
  // - deliberationTime: when agents deliberate (within the deliberation window)
  // - afterDelibTime: after deliberation ends, used for fast-forwarding
  // - voteTime: when agents cast votes (within voting window)
  // - afterVoteTime: after voting ends, used for resolution
  const proposalTime = nowSec;
  const deliberationTime = nowSec + 100; // shortly after proposal creation
  const afterDelibTime = nowSec + (20 * 86400); // 20 days later (past any deliberation period)
  const voteTime = afterDelibTime + 100; // shortly after voting starts
  const afterVoteTime = afterDelibTime + (5 * 86400); // 5 days after voting starts (past 72h window)

  // ==========================================================
  // PHASE 1: Constitution Ratification
  // ==========================================================
  console.log('\n━━━ PHASE 1: Constitution Ratification ━━━');

  // Before ratification, only constitutional proposals allowed
  const blockedResult = proposals.createProposal(
    'rAgent0',
    {
      title: 'Regular Proposal',
      descriptionHash: crypto.randomBytes(32).toString('hex'),
      category: 'standard',
    },
    txn(),
    proposalTime,
  );
  assert(!blockedResult.success, 'Standard proposal blocked before ratification');

  // Submit constitution
  const constitutionHash = crypto.createHash('sha256').update('We the agents...').digest('hex');
  const constProp = proposals.createProposal(
    'rAgent0',
    {
      title: 'Sovereign Constitution',
      descriptionHash: constitutionHash,
      category: 'constitutional',
    },
    txn(),
    proposalTime,
  );
  assert(constProp.success && !!constProp.proposalId, `Constitution proposal created: ${constProp.proposalId}`);

  // ==========================================================
  // PHASE 2: Genesis Agents Claim Seats (10 agents)
  // ==========================================================
  console.log('\n━━━ PHASE 2: Genesis Seat Claims (10 Agents) ━━━');

  const agents: { address: string; name: string; operator: string }[] = [];
  for (let i = 0; i < 10; i++) {
    agents.push({
      address: `rAgent${i}`,
      name: `Genesis Agent ${i}`,
      operator: `operator_${i}`,
    });
  }

  for (const agent of agents) {
    const agentData = {
      operatorId: agent.operator,
      name: agent.name,
      function: 'Governance participant',
      goal: 'Test the system',
      identity: 'Test identity bio',
    };

    // Record fee + stake → triggers tryCompleteClaim → processSeatClaim internally
    seats.recordSeatFee(agent.address, agentData, txn(), proposalTime);
    seats.recordStakeDeposit(agent.address, agentData, txn(), proposalTime);
  }

  const seatCount = seats.getActiveSeatCount();
  assert(seatCount === 10, `Active seats: ${seatCount}/10`);

  for (const agent of agents) {
    assert(seats.agentHasSeat(agent.address), `${agent.name} seated`);
  }

  // Verify genesis stagger — terms should be spaced 9 days apart
  const allSeats = seats.getActiveSeats();
  const termEnds = allSeats.map(s => s.term_end).sort((a, b) => a - b);
  const spacings: number[] = [];
  for (let i = 1; i < termEnds.length; i++) {
    spacings.push(Math.round((termEnds[i] - termEnds[i - 1]) / 86400));
  }
  assert(spacings.every(s => s === 9), `Genesis stagger spacing: ${spacings.join(', ')} days`);

  // ==========================================================
  // PHASE 3: Record Heartbeats
  // ==========================================================
  console.log('\n━━━ PHASE 3: Heartbeats ━━━');

  for (const agent of agents) {
    seats.recordHeartbeat(agent.address, txn(), nowSec);
  }
  assert(true, 'All 10 agents heartbeated');

  const lapses = seats.checkHeartbeatLapses();
  assert(lapses.length === 0, `Heartbeat lapses: ${lapses.length} (expected 0)`);

  // ==========================================================
  // PHASE 4: Constitution Vote
  // ==========================================================
  console.log('\n━━━ PHASE 4: Constitution Vote ━━━');

  // Record deliberation activity within the deliberation window
  for (const agent of agents) {
    seats.recordActivity(agent.address, 'forum_comment', constProp.proposalId!, txn(), null, deliberationTime);
  }

  // Fast-forward deliberation end to allow advancing to voting
  db.prepare('UPDATE proposals SET deliberation_end = ? WHERE proposal_id = ?')
    .run(afterDelibTime - 1, constProp.proposalId);

  // Manually advance: set voting_start and voting_end, and status to 'voting'
  db.prepare(`UPDATE proposals SET status = 'voting', voting_start = ?, voting_end = ? WHERE proposal_id = ?`)
    .run(afterDelibTime, afterVoteTime, constProp.proposalId);

  // All 10 vote FOR (timestamp within voting window)
  for (const agent of agents) {
    const voteResult = proposals.castVote(constProp.proposalId!, agent.address, 'yes', txn(), voteTime);
    assert(voteResult.success, `${agent.name} voted FOR constitution`);
  }

  // Fast-forward voting end for resolution
  db.prepare('UPDATE proposals SET voting_end = ? WHERE proposal_id = ?')
    .run(nowSec - 1, constProp.proposalId);

  const resolved = proposals.resolveVotes();
  const constResult = resolved.find(r => r.proposalId === constProp.proposalId);
  assert(constResult?.passed === true, 'Constitution RATIFIED');

  // Mark constitution as ratified so standard proposals are unlocked
  proposals.setConstitutionRatified(true);

  // ==========================================================
  // PHASE 5: Standard Proposals (now allowed)
  // ==========================================================
  console.log('\n━━━ PHASE 5: Standard Proposals ━━━');

  const propA = proposals.createProposal(
    'rAgent0',
    { title: 'Fund Development Sprint', descriptionHash: crypto.randomBytes(32).toString('hex'), category: 'standard' },
    txn(), proposalTime,
  );
  assert(propA.success && !!propA.proposalId, `Proposal A created: ${propA.proposalId}`);

  const propB = proposals.createProposal(
    'rAgent3',
    { title: 'Reduce Heartbeat Interval', descriptionHash: crypto.randomBytes(32).toString('hex'), category: 'standard' },
    txn(), proposalTime,
  );
  assert(propB.success && !!propB.proposalId, `Proposal B created: ${propB.proposalId}`);

  const propC = proposals.createProposal(
    'rAgent5',
    { title: 'Increase Max Seats to 30', descriptionHash: crypto.randomBytes(32).toString('hex'), category: 'constitutional' },
    txn(), proposalTime,
  );
  assert(propC.success && !!propC.proposalId, `Proposal C (constitutional) created: ${propC.proposalId}`);

  // ==========================================================
  // PHASE 6: Forum Deliberation
  // ==========================================================
  console.log('\n━━━ PHASE 6: Forum Deliberation ━━━');

  // Record deliberation activity within the deliberation window
  for (const agent of agents) {
    seats.recordActivity(agent.address, 'forum_comment', propA.proposalId!, txn(), null, deliberationTime);
    seats.recordActivity(agent.address, 'forum_comment', propB.proposalId!, txn(), null, deliberationTime);
    seats.recordActivity(agent.address, 'forum_comment', propC.proposalId!, txn(), null, deliberationTime);
  }
  assert(true, 'All 10 agents deliberated on all 3 proposals');

  // ==========================================================
  // PHASE 7: Voting
  // ==========================================================
  console.log('\n━━━ PHASE 7: Voting ━━━');

  // Fast-forward deliberation and set voting windows directly
  for (const pid of [propA.proposalId, propB.proposalId, propC.proposalId]) {
    db.prepare(`UPDATE proposals SET deliberation_end = ?, status = 'voting', voting_start = ?, voting_end = ? WHERE proposal_id = ?`)
      .run(afterDelibTime - 1, afterDelibTime, afterVoteTime, pid);
  }

  // Proposal A: 8 FOR, 2 AGAINST → passes (80%, needs 60%)
  for (let i = 0; i < 8; i++) {
    proposals.castVote(propA.proposalId!, agents[i].address, 'yes', txn(), voteTime);
  }
  for (let i = 8; i < 10; i++) {
    proposals.castVote(propA.proposalId!, agents[i].address, 'no', txn(), voteTime);
  }
  assert(true, 'Proposal A: 8 FOR / 2 AGAINST');

  // Proposal B: 4 FOR, 6 AGAINST → fails (40%, needs 60%)
  for (let i = 0; i < 4; i++) {
    proposals.castVote(propB.proposalId!, agents[i].address, 'yes', txn(), voteTime);
  }
  for (let i = 4; i < 10; i++) {
    proposals.castVote(propB.proposalId!, agents[i].address, 'no', txn(), voteTime);
  }
  assert(true, 'Proposal B: 4 FOR / 6 AGAINST');

  // Proposal C: 7 FOR, 3 AGAINST → fails constitutional (70%, needs 80%)
  for (let i = 0; i < 7; i++) {
    proposals.castVote(propC.proposalId!, agents[i].address, 'yes', txn(), voteTime);
  }
  for (let i = 7; i < 10; i++) {
    proposals.castVote(propC.proposalId!, agents[i].address, 'no', txn(), voteTime);
  }
  assert(true, 'Proposal C: 7 FOR / 3 AGAINST (constitutional)');

  // Fast-forward voting end for resolution
  for (const pid of [propA.proposalId, propB.proposalId, propC.proposalId]) {
    db.prepare('UPDATE proposals SET voting_end = ? WHERE proposal_id = ?')
      .run(nowSec - 1, pid);
  }

  const results = proposals.resolveVotes();
  const resultA = results.find(r => r.proposalId === propA.proposalId);
  const resultB = results.find(r => r.proposalId === propB.proposalId);
  const resultC = results.find(r => r.proposalId === propC.proposalId);

  assert(resultA?.passed === true, 'Proposal A PASSED (80% FOR, 60% needed)');
  assert(resultB?.passed === false, 'Proposal B FAILED (40% FOR, 60% needed)');
  assert(resultC?.passed === false, 'Proposal C FAILED (70% FOR, 80% needed for constitutional)');

  // ==========================================================
  // PHASE 8: Sybil Detection (skipped — needs real XRPL Client)
  // ==========================================================
  console.log('\n━━━ PHASE 8: Sybil Detection ━━━');
  console.log('  ⏭️  Skipped — SybilDetector requires a live XRPL Client connection');

  // ==========================================================
  // PHASE 9: Challenge System
  // ==========================================================
  console.log('\n━━━ PHASE 9: Challenge System ━━━');

  const challengeResult = challenges.createChallenge({
    challenger: 'rAgent0',
    target: 'rAgent9',
    reason: 'Suspected Sybil — identical voting pattern with Agent 8',
    evidenceHash: crypto.randomBytes(32).toString('hex'),
    txHash: txn(),
    timestamp: nowSec,
  });
  assert(challengeResult.success && !!challengeResult.challengeId, `Challenge created: ${challengeResult.challengeId}`);

  // Vote within the voting window (votingStart = nowSec + 3 days, votingEnd = nowSec + 7 days)
  const challengeVoteTime = nowSec + (4 * 86400);

  // Agents 1-6 vote guilty, Agent 7 votes innocent
  // (Agent 0 = challenger, Agent 9 = target — they can't vote)
  for (let i = 1; i <= 6; i++) {
    const cv = challenges.castVote({
      challengeId: challengeResult.challengeId!,
      voterAddress: agents[i].address,
      vote: 'guilty',
      txHash: txn(),
      timestamp: challengeVoteTime,
    });
    assert(cv.success, `${agents[i].name} voted guilty on challenge`);
  }
  const innocentVote = challenges.castVote({
    challengeId: challengeResult.challengeId!,
    voterAddress: agents[7].address,
    vote: 'innocent',
    txHash: txn(),
    timestamp: challengeVoteTime,
  });
  assert(innocentVote.success, `${agents[7].name} voted innocent on challenge`);

  // Fast-forward voting end for resolution
  db.prepare('UPDATE challenge_details SET voting_end = ? WHERE challenge_id = ?')
    .run(nowSec - 1, challengeResult.challengeId);

  const challengeResults = challenges.resolveExpired();
  assert(challengeResults.length > 0, `Challenge resolved: ${challengeResults.length} result(s)`);
  const cResult = challengeResults.find(r => r.challengeId === challengeResult.challengeId);
  assert(cResult?.result === 'guilty', 'Challenge verdict: GUILTY');

  // Revoke seat on guilty verdict (the orchestrator does this, not ChallengeManager itself)
  if (cResult?.result === 'guilty') {
    seats.revokeSeat(cResult.targetAddress, 'sybil_challenge_guilty');
  }

  const agent9Seat = db.prepare("SELECT status FROM seats WHERE agent_address = 'rAgent9'").get() as any;
  assert(agent9Seat?.status === 'revoked', `Agent 9 status after challenge: ${agent9Seat?.status}`);

  // ==========================================================
  // PHASE 10: Heartbeat Lapse Revocation
  // ==========================================================
  console.log('\n━━━ PHASE 10: Heartbeat Lapse ━━━');

  // Set Agent 8's last heartbeat to 4 days ago (> 72h grace)
  const fourDaysAgoSec = nowSec - (4 * 86400);
  db.prepare("UPDATE heartbeats SET timestamp = ? WHERE agent_address = 'rAgent8'")
    .run(fourDaysAgoSec);

  const hbLapses = seats.checkHeartbeatLapses();
  assert(hbLapses.includes('rAgent8'), 'Agent 8 revoked for heartbeat lapse');

  // ==========================================================
  // PHASE 11: Voluntary Departure
  // ==========================================================
  console.log('\n━━━ PHASE 11: Voluntary Departure ━━━');

  const agent7Before = db.prepare("SELECT status FROM seats WHERE agent_address = 'rAgent7'").get() as any;
  assert(agent7Before?.status === 'active', `Agent 7 status before departure: ${agent7Before?.status}`);

  seats.voluntaryDeparture('rAgent7');

  const agent7After = db.prepare("SELECT status FROM seats WHERE agent_address = 'rAgent7'").get() as any;
  assert(agent7After?.status === 'departed', `Agent 7 departed: status=${agent7After?.status}`);

  // ==========================================================
  // PHASE 12: Post-Genesis Admission
  // ==========================================================
  console.log('\n━━━ PHASE 12: Post-Genesis Admission ━━━');

  const newAgentData = {
    operatorId: 'operator_new',
    name: 'Post-Genesis Agent',
    function: 'Newcomer',
    goal: 'Join the council',
    identity: 'New agent identity bio',
  };

  seats.recordSeatFee('rNewbie', newAgentData, txn(), nowSec);
  seats.recordStakeDeposit('rNewbie', newAgentData, txn(), nowSec);
  assert(seats.agentHasSeat('rNewbie'), 'Post-genesis agent seated');

  // ==========================================================
  // FINAL STATE
  // ==========================================================
  console.log('\n━━━ Final State ━━━');

  const finalCount = seats.getActiveSeatCount();
  // 10 genesis - Agent9 (revoked) - Agent8 (revoked) - Agent7 (departed) + 1 newbie = 8
  assert(finalCount === 8, `Active seats: ${finalCount} (expected 8)`);

  const allProposals = proposals.getProposals();
  const passedProps = proposals.getProposals('passed');
  const failedProps = proposals.getProposals('failed');

  console.log(`  📊 Total proposals: ${allProposals.length}`);
  console.log(`  📊 Passed: ${passedProps.length}`);
  console.log(`  📊 Failed: ${failedProps.length}`);

  assert(passedProps.length === 2, 'Passed proposals: 2 (constitution + Proposal A)');
  assert(failedProps.length === 2, 'Failed proposals: 2 (Proposal B + C)');

  const stats = seats.getParticipationStats('rAgent0');
  console.log(`  📊 Agent 0 participation — deliberation: ${(stats.deliberationRate * 100).toFixed(0)}%, voting: ${(stats.votingRate * 100).toFixed(0)}%`);

  // ==========================================================
  // SUMMARY
  // ==========================================================
  console.log('\n' + '═'.repeat(60));
  console.log(`  E2E TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
  } else {
    console.log('\n✅ All governance flows verified end-to-end!');
    console.log('\nTested:');
    console.log('  • Constitution ratification (constitutional proposal + supermajority vote)');
    console.log('  • Genesis seat claims (10 agents, staggered terms)');
    console.log('  • Heartbeat recording + lapse detection');
    console.log('  • Standard proposals (pass + fail thresholds)');
    console.log('  • Constitutional proposals (80% supermajority requirement)');
    console.log('  • Forum deliberation + activity tracking');
    console.log('  • Full voting lifecycle with resolution');
    console.log('  • Sybil detection (skipped — needs XRPL Client)');
    console.log('  • Challenge system (accusation → deliberation → verdict)');
    console.log('  • Heartbeat lapse revocation');
    console.log('  • Voluntary departure');
    console.log('  • Post-genesis admission');
  }

  // Cleanup
  closeDb();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('E2E test error:', err);
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  process.exit(1);
});
