/**
 * Tests for the database layer — schema creation, basic CRUD, WAL mode.
 */
import '../helpers/setup';
import { getDb, closeDb } from '../../src/db/database';

describe('Database', () => {
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(() => {
    closeDb();
  });

  describe('initialization', () => {
    it('creates the database in WAL mode', () => {
      const mode = db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    });

    it('has foreign keys enabled', () => {
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });
  });

  describe('schema — seats table', () => {
    it('creates the seats table with correct columns', () => {
      const info = db.prepare("PRAGMA table_info('seats')").all() as any[];
      const columns = info.map((c: any) => c.name);
      expect(columns).toContain('id');
      expect(columns).toContain('agent_address');
      expect(columns).toContain('operator_id');
      expect(columns).toContain('name');
      expect(columns).toContain('function');
      expect(columns).toContain('goal');
      expect(columns).toContain('identity_bio');
      expect(columns).toContain('term_start');
      expect(columns).toContain('term_end');
      expect(columns).toContain('stake_amount');
      expect(columns).toContain('status');
    });

    it('enforces unique agent_address', () => {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rAgent1', 'op1', 'Test Agent 1', ?, ?, '50000000', 'active')
      `).run(now, now + 7776000);

      expect(() => {
        db.prepare(`
          INSERT INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
          VALUES ('rAgent1', 'op2', 'Duplicate', ?, ?, '50000000', 'active')
        `).run(now, now + 7776000);
      }).toThrow();
    });
  });

  describe('schema — proposals table', () => {
    it('creates the proposals table', () => {
      const info = db.prepare("PRAGMA table_info('proposals')").all() as any[];
      const columns = info.map((c: any) => c.name);
      expect(columns).toContain('proposal_id');
      expect(columns).toContain('author_address');
      expect(columns).toContain('title');
      expect(columns).toContain('category');
      expect(columns).toContain('status');
      expect(columns).toContain('votes_for');
      expect(columns).toContain('votes_against');
      expect(columns).toContain('total_voters');
    });
  });

  describe('schema — votes table', () => {
    it('enforces the vote CHECK constraint', () => {
      const now = Math.floor(Date.now() / 1000);

      // Insert prerequisite proposal and seat
      db.prepare(`
        INSERT OR IGNORE INTO proposals (proposal_id, author_address, title, description_hash, category, status, deliberation_start, deliberation_end, tx_hash)
        VALUES ('prop_test_1', 'rAuthor', 'Test', 'hash1', 'standard', 'voting', ?, ?, 'tx_1')
      `).run(now - 86400, now);

      db.prepare(`
        INSERT OR IGNORE INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rVoter1', 'op_v1', 'Voter1', ?, ?, '50000000', 'active')
      `).run(now - 86400, now + 7776000);

      // Valid vote values
      db.prepare(`
        INSERT INTO votes (proposal_id, agent_address, vote, tx_hash, timestamp)
        VALUES ('prop_test_1', 'rVoter1', 'yes', 'tx_vote_1', ?)
      `).run(now);

      // Invalid vote value should throw
      expect(() => {
        db.prepare(`
          INSERT INTO votes (proposal_id, agent_address, vote, tx_hash, timestamp)
          VALUES ('prop_test_1', 'rVoter1', 'maybe', 'tx_vote_bad', ?)
        `).run(now);
      }).toThrow();
    });
  });

  describe('schema — heartbeats table', () => {
    it('enforces unique tx_hash', () => {
      const now = Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT OR IGNORE INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
        VALUES ('rHBAgent', 'op_hb', 'HB Agent', ?, ?, '50000000', 'active')
      `).run(now - 86400, now + 7776000);

      db.prepare(`
        INSERT INTO heartbeats (agent_address, tx_hash, timestamp) VALUES ('rHBAgent', 'hb_tx_1', ?)
      `).run(now);

      expect(() => {
        db.prepare(`
          INSERT INTO heartbeats (agent_address, tx_hash, timestamp) VALUES ('rHBAgent', 'hb_tx_1', ?)
        `).run(now + 1);
      }).toThrow();
    });
  });

  describe('schema — all expected tables exist', () => {
    it.each([
      'seats', 'heartbeats', 'activity', 'proposals', 'votes',
      'forum_posts', 'vouchers', 'challenges', 'badges',
      'sovereign_state', 'forum_threads',
    ])('table "%s" exists', (table) => {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      expect(row).toBeTruthy();
    });
  });
});
