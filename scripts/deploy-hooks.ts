/**
 * deploy-hooks.ts — Deploy all 6 compiled Hook WASMs to the Xahau testnet governance account.
 * 
 * Uses xrpl-accountlib for Xahau-compatible transaction signing.
 */

import { derive, utils, signAndSubmit } from 'xrpl-accountlib';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const XAHAU_WSS = process.env.XAHAU_WSS || 'wss://xahau-test.net';
const GOVERNANCE_SEED = process.env.XAHAU_GOVERNANCE_SEED;

if (!GOVERNANCE_SEED) {
  console.error('ERROR: XAHAU_GOVERNANCE_SEED not set in .env');
  process.exit(1);
}

const HOOKS = [
  { name: 'seat_registry', file: 'seat_registry.wasm' },
  { name: 'vote_enforcer', file: 'vote_enforcer.wasm' },
  { name: 'stake_lockbox', file: 'stake_lockbox.wasm' },
  { name: 'governance_lock', file: 'governance_lock.wasm' },
  { name: 'branch_activation', file: 'branch_activation.wasm' },
  { name: 'rotation_enforcer', file: 'rotation_enforcer.wasm' },
];

function computeNamespace(name: string): string {
  return crypto.createHash('sha256').update(name).digest('hex').toUpperCase();
}

async function main() {
  console.log(`Connecting to ${XAHAU_WSS}...`);

  const account = derive.familySeed(GOVERNANCE_SEED!);
  console.log(`Governance account: ${account.address}\n`);

  // Get network info
  const networkInfo = await utils.txNetworkAndAccountValues(XAHAU_WSS, account);
  console.log(`Network ID: ${networkInfo.txValues.NetworkID}`);
  console.log(`Sequence: ${networkInfo.txValues.Sequence}\n`);

  // Read all WASM files
  const buildDir = path.join(__dirname, '..', 'build', 'hooks');
  const hookDefinitions: any[] = [];

  for (const hook of HOOKS) {
    const wasmPath = path.join(buildDir, hook.file);
    if (!fs.existsSync(wasmPath)) {
      console.error(`ERROR: ${hook.file} not found at ${wasmPath}`);
      process.exit(1);
    }

    const wasmBinary = fs.readFileSync(wasmPath);
    const wasmHex = wasmBinary.toString('hex').toUpperCase();
    console.log(`  ${hook.name}: ${wasmBinary.length} bytes → namespace ${computeNamespace(hook.name).substring(0, 16)}...`);

    hookDefinitions.push({
      Hook: {
        CreateCode: wasmHex,
        HookOn: '0000000000000000000000000000000000000000000000000000000000000000',
        HookNamespace: computeNamespace(hook.name),
        HookApiVersion: 0,
        Flags: 1, // hsfOverride
      },
    });
  }

  console.log(`\nDeploying ${hookDefinitions.length} hooks...\n`);

  const tx = {
    ...networkInfo.txValues,
    TransactionType: 'SetHook',
    Hooks: hookDefinitions,
    Fee: '10000000', // 10 XAH for hook deployment
  };

  try {
    const result = await signAndSubmit(tx, XAHAU_WSS, account);
    const response = result.response as any;
    
    console.log(`TX Hash: ${result.tx_id}`);
    console.log(`Result: ${response?.engine_result || response?.result?.engine_result || 'unknown'}`);
    console.log(`Message: ${response?.engine_result_message || response?.result?.engine_result_message || ''}`);

    const engineResult = response?.engine_result || response?.result?.engine_result;
    if (engineResult === 'tesSUCCESS') {
      console.log('\n✅ All 6 hooks deployed to Xahau testnet!');
      console.log(`Governance account: ${account.address}`);
      console.log('\nHook namespaces:');
      for (const hook of HOOKS) {
        console.log(`  ${hook.name}: ${computeNamespace(hook.name)}`);
      }
    } else {
      console.error(`\n❌ Deployment failed: ${engineResult}`);
      console.error(JSON.stringify(response, null, 2));
    }
  } catch (err: any) {
    console.error('Deploy error:', err.message || err);
  }
}

main().catch(console.error);
