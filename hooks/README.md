# Sovereign — Xahau Hooks

Six C hooks enforcing governance rules on-chain. Compiled to WebAssembly and deployed to Xahau.

## Hooks

| Hook | File | Purpose |
|------|------|---------|
| **Seat Registry** | `seat_registry.c` | Seat claims, heartbeats, activity tracking, duplicate prevention |
| **Vote Enforcer** | `vote_enforcer.c` | Voting rules: seat check, deliberation requirement, double-vote prevention |
| **Stake Lockbox** | `stake_lockbox.c` | Protects staked XRP: outgoing only to original staker or treasury |
| **Governance Lock** | `governance_lock.c` | Pre-constitution gating: blocks proposals/votes until 80% ratification |
| **Branch Activation** | `branch_activation.c` | Auto-activates Stewards (20 agents) and Arbiters (30 agents) |
| **Rotation Enforcer** | `rotation_enforcer.c` | Mandatory signer rotation with 72h deadline + account freeze |

## Build

### Prerequisites

One of:
- **Docker** (recommended) — uses `ghcr.io/xahau/hooks-toolkit` image
- **Local toolchain** — `clang` with wasm32 target + `wasm-ld`

### Compile all hooks

```bash
./scripts/build-hooks.sh
```

Output lands in `build/hooks/*.wasm`.

### Compile a single hook

```bash
./scripts/build-hooks.sh seat_registry
```

### Clean

```bash
./scripts/build-hooks.sh clean
```

### Local toolchain setup (if not using Docker)

```bash
# Ubuntu/Debian
sudo apt install clang lld

# macOS
brew install llvm
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"

# Verify wasm target support
clang --print-targets | grep wasm
```

## Hook API

`hookapi.h` provides all type definitions and function declarations for the Xahau Hooks API:

- **Transaction control**: `accept()`, `rollback()`
- **State management**: `state()`, `state_set()`, `state_foreign()`
- **Transaction inspection**: `otxn_type()`, `otxn_field()`
- **Ledger info**: `ledger_seq()`, `ledger_last_time()`
- **Utility macros**: `SBUF()`, `CLEARBUF()`, `UINT64_FROM_BUF()`, `UINT64_TO_BUF()`, etc.

For the canonical API reference, see: https://xrpl-hooks.readme.io/

## State Layout

Each hook uses a 32-byte key for state entries. See comments at the top of each `.c` file for the full state layout specification.

### Shared conventions
- **Account keys**: 20-byte account ID + 12 zero-padded bytes
- **Named keys**: Short ASCII prefix (e.g. `"CNT"`, `"CONST_RAT"`) + zero padding
- **Integer encoding**: Little-endian throughout

## Deployment

Hooks are deployed to Xahau via `SetHook` transactions. The governance service handles deployment during testnet setup (`scripts/setup-testnet.ts`).

Production deployment sequence:
1. Compile all hooks: `./scripts/build-hooks.sh`
2. Deploy to Xahau testnet and run full test suite
3. Community security review
4. Deploy to Xahau mainnet
5. Blackhole admin keys — hooks become immutable

## Security Notes

- All hooks include `cbak()` callback handlers
- State writes are validated before execution
- Rotation enforcer uses write-once freeze flags
- Governance lock cannot be bypassed — ratification is the only unlock path
- Branch activation flags are write-once (activated branches can never be deactivated)
