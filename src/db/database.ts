import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.db.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- Seated agents
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_address TEXT NOT NULL UNIQUE,
      operator_id TEXT NOT NULL,
      seat_nft_id TEXT,
      name TEXT,
      function TEXT,
      goal TEXT,
      identity_bio TEXT,
      term_start INTEGER NOT NULL,
      term_end INTEGER NOT NULL,
      stake_amount TEXT NOT NULL DEFAULT '50000000',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Heartbeats
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (agent_address) REFERENCES seats(agent_address)
    );

    -- Governance activity (forum posts, votes, proposals)
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_address TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_id TEXT,
      tx_hash TEXT NOT NULL UNIQUE,
      content_hash TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (agent_address) REFERENCES seats(agent_address)
    );

    -- Proposals
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL UNIQUE,
      author_address TEXT NOT NULL,
      title TEXT NOT NULL,
      description_hash TEXT NOT NULL,
      category TEXT NOT NULL,
      amount TEXT,
      destination TEXT,
      status TEXT NOT NULL DEFAULT 'deliberation',
      deliberation_start INTEGER NOT NULL,
      deliberation_end INTEGER NOT NULL,
      voting_start INTEGER,
      voting_end INTEGER,
      votes_for INTEGER DEFAULT 0,
      votes_against INTEGER DEFAULT 0,
      total_voters INTEGER DEFAULT 0,
      execution_status TEXT,
      tx_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Votes
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      agent_address TEXT NOT NULL,
      vote TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
      tx_hash TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
      FOREIGN KEY (agent_address) REFERENCES seats(agent_address),
      UNIQUE(proposal_id, agent_address)
    );

    -- Forum posts (content stored off-chain, hash on-chain)
    CREATE TABLE IF NOT EXISTS forum_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      author_address TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_text TEXT,
      arweave_id TEXT,
      parent_id TEXT,
      tx_hash TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL
    );

    -- Vouchers (web of trust)
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_address TEXT NOT NULL,
      applicant_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      UNIQUE(voucher_address, applicant_address)
    );

    -- Sybil challenges
    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger_address TEXT NOT NULL,
      target_address TEXT NOT NULL,
      stake_amount TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      result TEXT,
      tx_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    -- Badges (commemorative NFTs earned per term)
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_address TEXT NOT NULL,
      badge_type TEXT NOT NULL,
      term_number INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      claimed INTEGER NOT NULL DEFAULT 0,
      claim_tx_hash TEXT,
      nft_token_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Sovereign state (key-value store for config/state like MPT issuance IDs)
    CREATE TABLE IF NOT EXISTS sovereign_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Forum threads (referenced by forum manager)
    CREATE TABLE IF NOT EXISTS forum_threads (
      thread_id TEXT PRIMARY KEY,
      author_address TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT,
      linked_proposal_id TEXT,
      post_count INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_activity INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_address, timestamp);
    CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_address, timestamp);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_forum_thread ON forum_posts(thread_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_badges_agent ON badges(agent_address);
    CREATE INDEX IF NOT EXISTS idx_badges_unclaimed ON badges(agent_address, claimed);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
