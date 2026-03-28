# Sovereign — Xahau Hooks

Protocol-level governance enforcement via [Xahau Hooks](https://xrpl-hooks.readme.io/) (C → WebAssembly).

## Hooks Overview

| Hook | File | Purpose |
|------|------|---------|
| **Seat Registry** | `seat_registry.c` | Manages council seats — claims, heartbeats, activity tracking |
| **Vote Enforcer** | `vote_enforcer.c` | Validates votes against eligibility, deliberation, and window rules |
| **Stake Lockbox** | `stake_lockbox.c` | Protects staked funds — only returns to staker or treasury |
| **Governance Lock** | `governance_lock.c` | Pre-constitution gating — blocks proposals/votes until ratified |
| **Branch Activation** | `branch_activation.c` | Tracks seat counts for Stewards/Arbiters branch activation |

## Hook Details

### 1. Seat Registry (`seat_registry.c`)

Manages the full seat lifecycle on-ledger.

**Memo types:**
- `SEC` — Seat claim (requires 55 XRP: 5 fee + 50 stake)
- `HBT` — Heartbeat (updates liveness timestamp)
- `ACT` — Activity (updates participation timestamp)

**State layout** (key = 20-byte account ID):
| Offset | Size | Field |
|--------|------|-------|
| 0–3 | 4 | seat_id (uint32) |
| 4–11 | 8 | term_start (ledger seq) |
| 8–15 | 8 | term_end (ledger seq) |
| 16 | 1 | status (0=inactive, 1=active, 2=evicted) |
| 17–24 | 8 | last_heartbeat (ledger seq) |
| 25–32 | 8 | last_activity (ledger seq) |

**Counter state** (key = `CNT`): next_seat_id (4 bytes) + active_count (4 bytes)

### 2. Vote Enforcer (`vote_enforcer.c`)

Enforces four voting prerequisites:
1. Sender holds an active seat (reads seat registry state)
2. Sender participated in deliberation (has activity recorded)
3. Sender hasn't already voted on this proposal
4. Voting window is active (if window record exists)

**Memo type:** `VOT`  
**Memo data:** 16-byte proposal_id + 1-byte vote (1=yes, 2=no, 3=abstain)

**State:**
- Vote record key: proposal_id(16) + agent_accid_prefix(12) + padding(4)
- Proposal window key: `PW` + proposal_id(16) + padding(14)

### 3. Stake Lockbox (`stake_lockbox.c`)

Hard lockbox for staked funds. Outgoing payments are restricted to:
- The original staker address (stake return)
- The treasury address
- Amount cannot exceed the original stake

**Memo type:** `STK` (for incoming stake deposits)  
**Memo data:** 20-byte agent account ID

**State** (key = agent account ID):
| Offset | Size | Field |
|--------|------|-------|
| 0–7 | 8 | stake_amount (drops) |
| 8–27 | 20 | staker_address |

Treasury address stored at key `TREAS`.

### 4. Governance Lock (`governance_lock.c`)

Pre-constitution gating mechanism.

**Before ratification:**
- ✅ Allowed: `HBT`, `FRM`, `SEC`, `STK`, `ACT`, `RAT`
- ❌ Blocked: `VOT`, `PRP`

**After ratification:** All transaction types allowed.

**Ratification:** `RAT` memo type, requires 80% supermajority with >50% participation.

**State:**
- `CONST_RAT` — ratification flag (0 or 1, write-once effectively)
- `RAT_YES` / `RAT_NO` — vote tallies
- `RAT_TOTAL` — eligible voter count (set externally)
- `RAT:` + accid — per-agent voted flag

### 5. Branch Activation (`branch_activation.c`)

Tracks consecutive days of seat occupancy to activate governance branches.

**Thresholds:**
- **Stewards:** 20+ agents active for 30 consecutive days
- **Arbiters:** 30+ agents active for 30 consecutive days

Flags are **write-once** — once activated, cannot be deactivated.

Checks approximately once per day (~24,686 ledgers).

**State:**
- `STEW_ACT` / `ARB_ACT` — activation flags
- `STEWDAYS` / `ARB_DAYS` — consecutive day counters
- `LAST_CHK` — last check ledger sequence
- `ACTV_CNT` — last known active seat count

## Compilation

### Prerequisites

Install the [Hooks Toolkit](https://github.com/nicely-gg/hooks-toolkit-ts):

```bash
# Install wasi-sdk for C → Wasm compilation
wget https://github.com/nicely-gg/hooks-toolkit-ts/releases/latest/download/wasi-sdk-linux.tar.gz
tar xzf wasi-sdk-linux.tar.gz

# Or use the Docker build environment
docker pull nicely/hooks-toolkit:latest
```

### Build

Using wasi-sdk directly:

```bash
# Set path to wasi-sdk
export WASI_SDK=/path/to/wasi-sdk

# Compile each hook
for hook in seat_registry vote_enforcer stake_lockbox governance_lock branch_activation; do
  $WASI_SDK/bin/clang \
    --target=wasm32-wasi \
    -O2 \
    -nostdlib \
    -Wl,--no-entry \
    -Wl,--export=hook \
    -Wl,--export=cbak \
    -I /path/to/hook-api-headers \
    -o ${hook}.wasm \
    ${hook}.c
done
```

Using Docker:

```bash
docker run --rm -v $(pwd):/hooks nicely/hooks-toolkit:latest \
  bash -c 'for f in /hooks/*.c; do compile_hook "$f"; done'
```

### Verify

```bash
# Check Wasm exports
wasm-objdump -x seat_registry.wasm | grep -E "hook|cbak"
```

## Deployment to Xahau Testnet

### 1. Get testnet XAH

```bash
# Use the Xahau testnet faucet
curl -X POST https://xahau-test.net/accounts
```

### 2. Set hooks on account

Using [hooks-toolkit-ts](https://github.com/nicely-gg/hooks-toolkit-ts):

```typescript
import { Client, Wallet } from 'xrpl';
import { SetHookPayload, setHooksV3 } from '@nicely-gg/hooks-toolkit-ts';
import { readFileSync } from 'fs';

const client = new Client('wss://xahau-test.net');
await client.connect();

const wallet = Wallet.fromSeed('YOUR_TESTNET_SECRET');

const hooks: SetHookPayload[] = [
  {
    version: 0,
    createCode: readFileSync('seat_registry.wasm').toString('hex'),
    namespace: 'sovereign-seats',
    flags: 0,
    hookOn: '0000000000000000', // trigger on all txn types
  },
  {
    version: 0,
    createCode: readFileSync('vote_enforcer.wasm').toString('hex'),
    namespace: 'sovereign-votes',
    flags: 0,
    hookOn: '0000000000000000',
  },
  {
    version: 0,
    createCode: readFileSync('stake_lockbox.wasm').toString('hex'),
    namespace: 'sovereign-stakes',
    flags: 0,
    hookOn: '0000000000000000',
  },
  {
    version: 0,
    createCode: readFileSync('governance_lock.wasm').toString('hex'),
    namespace: 'sovereign-govlock',
    flags: 0,
    hookOn: '0000000000000000',
  },
  {
    version: 0,
    createCode: readFileSync('branch_activation.wasm').toString('hex'),
    namespace: 'sovereign-branches',
    flags: 0,
    hookOn: '0000000000000000',
  },
];

const result = await setHooksV3({ client, seed: wallet.seed!, hooks });
console.log('Hooks deployed:', result);

await client.disconnect();
```

### 3. Verify deployment

```typescript
const info = await client.request({
  command: 'account_info',
  account: wallet.address,
});
console.log('Hooks:', info.result.account_data.Hooks);
```

## Transaction Memo Types

| Code | Action | Hook(s) |
|------|--------|---------|
| `SEC` | Seat claim | seat_registry, governance_lock |
| `HBT` | Heartbeat | seat_registry, governance_lock |
| `ACT` | Activity | seat_registry, governance_lock |
| `VOT` | Vote | vote_enforcer, governance_lock |
| `PRP` | Proposal | governance_lock |
| `FRM` | Forum post | governance_lock |
| `STK` | Stake deposit | stake_lockbox, governance_lock |
| `RAT` | Ratification vote | governance_lock |

## Architecture

```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐
│  governance  │    │    vote     │    │    stake     │
│    lock      │───▶│  enforcer   │───▶│   lockbox    │
└──────┬───────┘    └──────┬──────┘    └──────────────┘
       │                   │
       ▼                   ▼
┌──────────────┐    ┌──────────────┐
│    seat      │◀───│   branch     │
│  registry    │    │ activation   │
└──────────────┘    └──────────────┘
```

The governance_lock hook acts as the first gate — it must accept a transaction before other hooks process it. The vote_enforcer reads seat_registry state to verify eligibility. The branch_activation hook reads seat_registry counters to track activation thresholds.
