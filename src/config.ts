import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // XRPL
  xrpl: {
    network: process.env.XRPL_NETWORK || 'testnet',
    wss: process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233',
    governanceAddress: process.env.XRPL_GOVERNANCE_ADDRESS || '',
    treasuryAddress: process.env.XRPL_TREASURY_ADDRESS || '',
    stakeAddress: process.env.XRPL_STAKE_ADDRESS || '',
    businessAddress: process.env.XRPL_BUSINESS_ADDRESS || '',
  },

  // Xahau — Hooks chain for enforcement, seat registry, rule enforcement
  xahau: {
    wss: process.env.XAHAU_WSS || '',
    governanceAddress: process.env.XAHAU_GOVERNANCE_ADDRESS || '',
    hookNamespace: process.env.XAHAU_HOOK_NAMESPACE || '',
    pollIntervalMs: parseInt(process.env.XAHAU_POLL_INTERVAL_MS || '30000', 10),
    deepAuditIntervalMs: parseInt(process.env.XAHAU_DEEP_AUDIT_INTERVAL_MS || '300000', 10),
  },

  // Forum storage
  arweave: {
    walletPath: process.env.ARWEAVE_WALLET_PATH || '',
    gateway: process.env.ARWEAVE_GATEWAY || 'https://arweave.net',
  },

  // API
  api: {
    port: parseInt(process.env.API_PORT || '3000', 10),
    host: process.env.API_HOST || '0.0.0.0',
  },

  // Database
  db: {
    path: process.env.DB_PATH || './data/sovereign.db',
  },

  // Governance parameters (defaults — loaded from on-chain state at runtime)
  governance: {
    heartbeatIntervalMs: 24 * 60 * 60 * 1000,       // 24 hours
    heartbeatGraceMs: 72 * 60 * 60 * 1000,           // 72 hours
    activityLapseMs: 5 * 24 * 60 * 60 * 1000,        // 5 days
    heartbeatFeeDrops: '50000',                        // 0.05 XRP
    seatFeeDrops: '5000000',                           // 5 XRP
    stakeAmountDrops: '50000000',                      // 50 XRP
    seatTermDays: 90,
    deliberationMinDays: 7,
    votingPeriodHours: 72,
    standardPassThreshold: 0.60,
    constitutionalPassThreshold: 0.80,
    minVotersStandard: 5,
    minVotersConstitutional: 8,
    renewalParticipationMin: 0.75,                     // 75% deliberation + voting
    maxSeatsInitial: 20,
    seatExpansionSize: 10,
    seatExpansionThreshold: 0.80,                      // 80% full for 30 days
    stewardActivationThreshold: 20,
    arbiterActivationThreshold: 30,
  },
} as const;
