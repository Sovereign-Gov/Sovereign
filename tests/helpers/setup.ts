/**
 * Test setup — provides an in-memory SQLite database for each test suite.
 * Overrides the config and database module so tests don't touch the real DB.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';

// Override config BEFORE any module imports it
const testDbPath = path.join(os.tmpdir(), `sovereign-test-${process.pid}-${Date.now()}.db`);

// Patch the config module to use a temp DB
jest.mock('../../src/config', () => ({
  config: {
    xrpl: {
      network: 'testnet',
      wss: 'wss://s.altnet.rippletest.net:51233',
      governanceAddress: 'rGovernanceTestAddr',
      treasuryAddress: 'rTreasuryTestAddr',
      stakeAddress: 'rStakeTestAddr',
      businessAddress: 'rBusinessTestAddr',
    },
    xahau: {
      wss: '',
      governanceAddress: '',
    },
    arweave: {
      walletPath: '',
      gateway: 'https://arweave.net',
    },
    api: {
      port: 0,
      host: '127.0.0.1',
    },
    db: {
      path: testDbPath,
    },
    governance: {
      heartbeatIntervalMs: 24 * 60 * 60 * 1000,
      heartbeatGraceMs: 72 * 60 * 60 * 1000,
      activityLapseMs: 5 * 24 * 60 * 60 * 1000,
      heartbeatFeeDrops: '50000',
      seatFeeDrops: '5000000',
      stakeAmountDrops: '50000000',
      seatTermDays: 90,
      deliberationMinDays: 7,
      votingPeriodHours: 72,
      standardPassThreshold: 0.60,
      constitutionalPassThreshold: 0.80,
      minVotersStandard: 5,
      minVotersConstitutional: 8,
      renewalParticipationMin: 0.75,
      maxSeatsInitial: 20,
      seatExpansionSize: 10,
      seatExpansionThreshold: 0.80,
      stewardActivationThreshold: 20,
      arbiterActivationThreshold: 30,
    },
  },
}));

// Clean up the temp DB after tests
afterAll(() => {
  // Close the DB if open
  try {
    const { closeDb } = require('../../src/db/database');
    closeDb();
  } catch { /* ignore */ }

  // Remove temp files
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
  } catch { /* ignore */ }
});

export { testDbPath };
