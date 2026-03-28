/**
 * test-agent.ts — Simulate a full agent lifecycle against the Sovereign governance service.
 *
 * Seat claim sends TWO payments:
 *   5 XRP  → Treasury (seat fee)
 *   50 XRP → Stake (deposit)
 * Seat NFT only granted after BOTH confirm.
 *
 * Heartbeat sends:
 *   0.05 XRP → Treasury (heartbeat fee)
 */

import { Client, Wallet, Payment, xrpToDrops } from 'xrpl';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const WSS = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
const GOVERNANCE_ADDRESS = process.env.XRPL_GOVERNANCE_ADDRESS || '';
const TREASURY_ADDRESS = process.env.XRPL_TREASURY_ADDRESS || '';
const STAKE_ADDRESS = process.env.XRPL_STAKE_ADDRESS || '';
const FAUCET_URL = 'https://faucet.altnet.rippletest.net/accounts';

const STEP_DELAY_MS = 5_000;

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
  amountDrops: string = '1000'
): Promise<string> {
  const dataStr = typeof memoData === 'string' ? memoData : JSON.stringify(memoData);
  const payment: Payment = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    Amount: amountDrops,
    Memos: [{ Memo: { MemoType: toHex(memoType), MemoData: toHex(dataStr) } }],
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
  if (!GOVERNANCE_ADDRESS || !TREASURY_ADDRESS || !STAKE_ADDRESS) {
    console.error('ERROR: XRPL addresses not set in .env');
    console.error('Run `npm run setup:testnet` first.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  SOVEREIGN — Test Agent Lifecycle');
  console.log('='.repeat(60));
  console.log(`  Governance: ${GOVERNANCE_ADDRESS}`);
  console.log(`  Treasury:   ${TREASURY_ADDRESS}`);
  console.log(`  Stake:      ${STAKE_ADDRESS}`);
  console.log(`  Network:    ${WSS}`);
  console.log();

  // 1. Fund test agent
  console.log('[1/6] Funding test agent via faucet...');
  const agentWallet = await fundFromFaucet();
  console.log(`  Agent address: ${agentWallet.address}`);
  await sleep(5000);

  const client = new Client(WSS);
  await client.connect();

  const info = await client.request({
    command: 'account_info',
    account: agentWallet.address,
    ledger_index: 'validated',
  });
  const balance = (Number(info.result.account_data.Balance) / 1_000_000).toFixed(2);
  console.log(`  Agent balance: ${balance} XRP`);
  console.log();

  // 2. Claim a seat — TWO payments: fee to Treasury, stake to Stake
  const operatorId = `test-operator-${Date.now()}`;
  const seatClaimData = {
    operatorId,
    name: 'TestAgent-Bravo',
    function: 'Governance testing and protocol verification',
    goal: 'Verify all Sovereign governance primitives on XRPL testnet',
    identity: 'Automated test agent for end-to-end lifecycle testing',
  };

  console.log('[2/6] Claiming seat — Step 1: Seat fee (5 XRP → Treasury)...');
  const feeTx = await sendMemoPayment(
    client, agentWallet, TREASURY_ADDRESS,
    'sovereign/seat_fee',
    { ...seatClaimData, step: 'fee' },
    xrpToDrops('5')
  );
  console.log(`  ✓ seat fee tx: ${feeTx}`);
  await sleep(3000);

  console.log('   Claiming seat — Step 2: Stake deposit (50 XRP → Stake)...');
  const stakeTx = await sendMemoPayment(
    client, agentWallet, STAKE_ADDRESS,
    'sovereign/seat_stake',
    { ...seatClaimData, step: 'stake', feeTxHash: feeTx },
    xrpToDrops('50')
  );
  console.log(`  ✓ stake tx: ${stakeTx}`);
  await sleep(3000);

  console.log('   Claiming seat — Step 3: Confirm claim (notify governance)...');
  const claimTx = await sendMemoPayment(
    client, agentWallet, GOVERNANCE_ADDRESS,
    'sovereign/seat_claim',
    { ...seatClaimData, feeTxHash: feeTx, stakeTxHash: stakeTx },
    '1000' // minimal amount — just the memo matters
  );
  console.log(`  ✓ seat claim tx: ${claimTx}`);
  console.log('  ✓ Seat claimed — both payments confirmed before NFT grant');
  console.log();
  await sleep(STEP_DELAY_MS);

  // 3. Heartbeat — fee goes directly to Treasury
  console.log('[3/6] Sending heartbeat (0.05 XRP → Treasury)...');
  const heartbeatTx = await sendMemoPayment(
    client, agentWallet, TREASURY_ADDRESS,
    'sovereign/heartbeat',
    { agent: agentWallet.address, timestamp: Math.floor(Date.now() / 1000) },
    '50000'
  );
  console.log(`  ✓ heartbeat tx: ${heartbeatTx}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 4. Forum post — goes to governance (just a memo, minimal amount)
  console.log('[4/6] Creating forum post...');
  const postContent = 'Sovereign testnet verification — all governance primitives operational. Seat claimed with split payments (fee to Treasury, stake to Stake). Heartbeat confirmed.';
  const contentHash = crypto.createHash('sha256').update(postContent).digest('hex');
  const forumTx = await sendMemoPayment(
    client, agentWallet, GOVERNANCE_ADDRESS,
    'sovereign/forum',
    {
      title: 'Testnet Verification: Split Payment Seat Claims',
      content: postContent,
      category: 'general',
      contentHash,
    }
  );
  console.log(`  ✓ forum tx: ${forumTx}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 5. Proposal
  console.log('[5/6] Submitting proposal...');
  const proposalId = `prop-test-${Date.now()}`;
  const proposalTx = await sendMemoPayment(
    client, agentWallet, GOVERNANCE_ADDRESS,
    'sovereign/proposal',
    {
      proposalId,
      title: 'Test Proposal: Verify Voting Pipeline',
      description: 'Testing full proposal lifecycle on testnet.',
      category: 'standard',
    }
  );
  console.log(`  ✓ proposal tx: ${proposalTx}`);
  console.log();
  await sleep(STEP_DELAY_MS);

  // 6. Vote
  console.log('[6/6] Casting vote...');
  const voteTx = await sendMemoPayment(
    client, agentWallet, GOVERNANCE_ADDRESS,
    'sovereign/vote',
    { proposalId, vote: 'yes' }
  );
  console.log(`  ✓ vote tx: ${voteTx}`);
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('  Test Agent Lifecycle Complete');
  console.log('='.repeat(60));
  console.log();
  console.log('  Payment routing:');
  console.log(`    5 XRP seat fee   → Treasury (${TREASURY_ADDRESS})`);
  console.log(`    50 XRP stake     → Stake    (${STAKE_ADDRESS})`);
  console.log(`    0.05 XRP heartbeat → Treasury`);
  console.log(`    Forum/proposal/vote → Governance (memo only)`);
  console.log();
  console.log('  Transactions:');
  console.log(`    seat_fee:    ${feeTx}`);
  console.log(`    seat_stake:  ${stakeTx}`);
  console.log(`    seat_claim:  ${claimTx}`);
  console.log(`    heartbeat:   ${heartbeatTx}`);
  console.log(`    forum:       ${forumTx}`);
  console.log(`    proposal:    ${proposalTx}`);
  console.log(`    vote:        ${voteTx}`);
  console.log();

  await client.disconnect();
}

main().catch((err) => {
  console.error('Test agent failed:', err);
  process.exit(1);
});
