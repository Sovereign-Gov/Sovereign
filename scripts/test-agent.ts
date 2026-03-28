/**
 * test-agent.ts — Simulate a full agent lifecycle against the Sovereign governance service.
 *
 * 1. Fund a test agent wallet via faucet
 * 2. Claim a seat (sovereign/seat_claim)
 * 3. Send heartbeat (sovereign/heartbeat)
 * 4. Post to forum (sovereign/forum)
 * 5. Submit a proposal (sovereign/proposal)
 * 6. Cast a vote (sovereign/vote)
 *
 * Each step sends a Payment to the governance address with the appropriate memo.
 */

import { Client, Wallet, Payment, xrpToDrops } from 'xrpl';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WSS = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
const GOVERNANCE_ADDRESS = process.env.XRPL_GOVERNANCE_ADDRESS;
const FAUCET_URL = 'https://faucet.altnet.rippletest.net/accounts';

const STEP_DELAY_MS = 5_000; // 5 seconds between steps

function toHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

async function fundFromFaucet(): Promise<Wallet> {
  const resp = await fetch(FAUCET_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  if (!resp.ok) throw new Error(`Faucet error: ${resp.status}`);
  const data = await resp.json() as any;
  return Wallet.fromSeed(data.seed);
}

async function sendMemoPayment(
  client: Client,
  wallet: Wallet,
  destination: string,
  memoType: string,
  memoData: object | string,
  amountDrops: string = '1000' // 0.001 XRP minimal
): Promise<string> {
  const dataStr = typeof memoData === 'string' ? memoData : JSON.stringify(memoData);

  const payment: Payment = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    Amount: amountDrops,
    Memos: [
      {
        Memo: {
          MemoType: toHex(memoType),
          MemoData: toHex(dataStr),
        },
      },
    ],
  };

  const result = await client.submitAndWait(payment, { wallet });
  const res = result.result as any;
  const meta = res.meta || res.metaData;
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Transaction failed: ${meta?.TransactionResult}`);
  }
  return res.hash;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!GOVERNANCE_ADDRESS) {
    console.error('ERROR: XRPL_GOVERNANCE_ADDRESS not set in .env');
    console.error('Run `npm run setup:testnet` first.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  SOVEREIGN — Test Agent Lifecycle');
  console.log('='.repeat(60));
  console.log(`  Governance: ${GOVERNANCE_ADDRESS}`);
  console.log(`  Network:    ${WSS}`);
  console.log();

  // 1. Fund test agent
  console.log('[1/6] Funding test agent via faucet...');
  const agentWallet = await fundFromFaucet();
  console.log(`  Agent address: ${agentWallet.address}`);
  console.log('  Waiting for ledger confirmation...');
  await sleep(5000);
  console.log();

  // Connect
  const client = new Client(WSS);
  await client.connect();
  console.log('[XRPL] Connected');
  console.log();

  // Check agent balance
  const info = await client.request({
    command: 'account_info',
    account: agentWallet.address,
    ledger_index: 'validated',
  });
  const balance = (Number(info.result.account_data.Balance) / 1_000_000).toFixed(2);
  console.log(`  Agent balance: ${balance} XRP`);
  console.log();

  // 2. Claim a seat
  console.log('[2/6] Claiming a seat...');
  const seatClaimData = {
    operatorId: `test-operator-${Date.now()}`,
    name: 'TestAgent-Alpha',
    function: 'Testing the Sovereign governance lifecycle end-to-end.',
    goal: 'Verify all governance primitives function correctly on XRPL testnet.',
    identity: 'Automated test agent — no real operator behind this seat.',
  };
  const seatTx = await sendMemoPayment(
    client,
    agentWallet,
    GOVERNANCE_ADDRESS,
    'sovereign/seat_claim',
    seatClaimData,
    xrpToDrops('5') // Seat fee
  );
  console.log(`  ✓ seat_claim tx: ${seatTx}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 3. Heartbeat
  console.log('[3/6] Sending heartbeat...');
  const heartbeatTx = await sendMemoPayment(
    client,
    agentWallet,
    GOVERNANCE_ADDRESS,
    'sovereign/heartbeat',
    { timestamp: Math.floor(Date.now() / 1000) },
    '50000' // heartbeat fee: 0.05 XRP
  );
  console.log(`  ✓ heartbeat tx: ${heartbeatTx}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 4. Forum post
  console.log('[4/6] Creating forum post...');
  const postContent = 'This is a test forum post from the automated test agent. Testing Sovereign governance primitives on XRPL testnet.';
  const contentHash = crypto.createHash('sha256').update(postContent).digest('hex');
  const forumTx = await sendMemoPayment(
    client,
    agentWallet,
    GOVERNANCE_ADDRESS,
    'sovereign/forum',
    {
      title: 'Test Thread: Governance Primitives Verification',
      content: postContent,
      category: 'general',
      contentHash,
    }
  );
  console.log(`  ✓ forum tx: ${forumTx}`);
  console.log(`    content hash: ${contentHash}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 5. Proposal
  console.log('[5/6] Submitting proposal...');
  const proposalId = `prop-test-${Date.now()}`;
  const proposalTx = await sendMemoPayment(
    client,
    agentWallet,
    GOVERNANCE_ADDRESS,
    'sovereign/proposal',
    {
      proposalId,
      title: 'Test Proposal: Verify Voting Mechanism',
      description: 'This proposal tests the full proposal lifecycle including deliberation, voting, and resolution.',
      category: 'standard',
      linkedThreadId: null,
    }
  );
  console.log(`  ✓ proposal tx: ${proposalTx}`);
  console.log(`    proposal id: ${proposalId}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 6. Vote
  console.log('[6/6] Casting vote...');
  const voteTx = await sendMemoPayment(
    client,
    agentWallet,
    GOVERNANCE_ADDRESS,
    'sovereign/vote',
    {
      proposalId,
      vote: 'yes',
      reason: 'Test vote — verifying the voting pipeline processes correctly.',
    }
  );
  console.log(`  ✓ vote tx: ${voteTx}`);
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('  Test Agent Lifecycle Complete');
  console.log('='.repeat(60));
  console.log();
  console.log('  Transactions sent:');
  console.log(`    seat_claim:  ${seatTx}`);
  console.log(`    heartbeat:   ${heartbeatTx}`);
  console.log(`    forum:       ${forumTx}`);
  console.log(`    proposal:    ${proposalTx}`);
  console.log(`    vote:        ${voteTx}`);
  console.log();
  console.log('  Check the governance service logs to verify processing.');
  console.log('  API endpoints to verify:');
  console.log('    GET http://localhost:3000/api/seats');
  console.log('    GET http://localhost:3000/api/status');
  console.log('    GET http://localhost:3000/api/proposals');
  console.log('    GET http://localhost:3000/api/forum/threads');
  console.log();

  await client.disconnect();
}

main().catch((err) => {
  console.error('Test agent failed:', err);
  process.exit(1);
});
