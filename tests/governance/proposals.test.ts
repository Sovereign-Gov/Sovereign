/**
 * Tests for ProposalManager — proposal lifecycle, voting, resolution.
 */
import '../helpers/setup';
import { ProposalManager, ProposalData } from '../../src/governance/proposals';
import { getDb } from '../../src/db/database';

describe('ProposalManager', () => {
  let manager: ProposalManager;
  let db: ReturnType<typeof getDb>;

  const now = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    manager = new ProposalManager();
    db = getDb();
    db.exec('DELETE FROM votes');
    db.exec('DELETE FROM activity');
    db.exec('DELETE FROM proposals');
    db.exec('DELETE FROM seats');
  });

  function seedSeat(agent: string, operatorId: string): void {
    const t = now();
    db.prepare(`
      INSERT OR IGNORE INTO seats (agent_address, operator_id, name, term_start, term_end, stake_amount, status)
      VALUES (?, ?, ?, ?, ?, '50000000', 'active')
    `).run(agent, operatorId, `Agent ${agent}`, t - 86400, t + 7776000);
  }

  function makeProposal(overrides: Partial<ProposalData> = {}): ProposalData {
    return {
      title: 'Test Proposal',
      descriptionHash: 'abc123',
      category: 'standard',
      ...overrides,
    };
  }

  // --- Proposal Creation ---

  describe('createProposal', () => {
    it('creates a standard proposal when constitution is ratified', () => {
      manager.setConstitutionRatified(true);
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', now());
      expect(result.success).toBe(true);
      expect(result.proposalId).toBeDefined();
    });

    it('blocks non-constitutional proposals before ratification', () => {
      manager.setConstitutionRatified(false);
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', now());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('constitution');
    });

    it('allows constitutional proposals before ratification', () => {
      manager.setConstitutionRatified(false);
      const result = manager.createProposal('rAuthor', makeProposal({ category: 'constitutional' }), 'tx_1', now());
      expect(result.success).toBe(true);
    });

    it('stores the proposal in deliberation status', () => {
      manager.setConstitutionRatified(true);
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', now());
      const proposal = manager.getProposal(result.proposalId!);
      expect(proposal).toBeDefined();
      expect(proposal!.status).toBe('deliberation');
      expect(proposal!.author_address).toBe('rAuthor');
    });

    it('sets deliberation period to 14 days for constitutional proposals', () => {
      manager.setConstitutionRatified(true);
      const t = now();
      const result = manager.createProposal('rAuthor', makeProposal({ category: 'constitutional' }), 'tx_1', t);
      const proposal = manager.getProposal(result.proposalId!);
      const days = (proposal!.deliberation_end - proposal!.deliberation_start) / 86400;
      expect(days).toBe(14);
    });

    it('sets deliberation period to 7 days for standard proposals', () => {
      manager.setConstitutionRatified(true);
      const t = now();
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', t);
      const proposal = manager.getProposal(result.proposalId!);
      const days = (proposal!.deliberation_end - proposal!.deliberation_start) / 86400;
      expect(days).toBe(7);
    });
  });

  // --- Advance to Voting ---

  describe('advanceToVoting', () => {
    it('advances proposals past deliberation to voting', () => {
      manager.setConstitutionRatified(true);
      const pastTime = now() - 8 * 86400; // 8 days ago
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', pastTime);

      const advanced = manager.advanceToVoting();
      expect(advanced).toContain(result.proposalId);

      const proposal = manager.getProposal(result.proposalId!);
      expect(proposal!.status).toBe('voting');
      expect(proposal!.voting_start).toBeDefined();
      expect(proposal!.voting_end).toBeDefined();
    });

    it('does not advance proposals still in deliberation', () => {
      manager.setConstitutionRatified(true);
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', now());
      const advanced = manager.advanceToVoting();
      expect(advanced).not.toContain(result.proposalId);
    });

    it('sets voting window to 72 hours', () => {
      manager.setConstitutionRatified(true);
      const pastTime = now() - 8 * 86400;
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', pastTime);
      manager.advanceToVoting();

      const proposal = manager.getProposal(result.proposalId!);
      const hours = (proposal!.voting_end! - proposal!.voting_start!) / 3600;
      expect(hours).toBe(72);
    });
  });

  // --- Cast Vote ---

  describe('castVote', () => {
    let proposalId: string;

    beforeEach(() => {
      manager.setConstitutionRatified(true);
      // Create proposal in the past so deliberation is over
      const pastTime = now() - 8 * 86400;
      const result = manager.createProposal('rAuthor', makeProposal(), 'tx_1', pastTime);
      proposalId = result.proposalId!;

      // Advance to voting
      manager.advanceToVoting();

      // Seed voters
      for (let i = 0; i < 10; i++) {
        seedSeat(`rVoter${i}`, `op_${i}`);
      }
    });

    it('rejects vote on non-voting proposal', () => {
      manager.setConstitutionRatified(true);
      const newProp = manager.createProposal('rA', makeProposal(), 'tx_new', now());
      const result = manager.castVote(newProp.proposalId!, 'rVoter0', 'yes', 'tx_v1', now());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('not in voting phase');
    });

    it('rejects vote from agent without deliberation', () => {
      const result = manager.castVote(proposalId, 'rVoter0', 'yes', 'tx_v1', now());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('deliberation');
    });

    it('accepts vote from agent who deliberated', () => {
      const proposal = manager.getProposal(proposalId)!;
      // Record deliberation activity during deliberation window
      db.prepare(`
        INSERT INTO activity (agent_address, action_type, target_id, tx_hash, content_hash, timestamp)
        VALUES ('rVoter0', 'forum_comment', ?, 'act_delib_0', 'hash0', ?)
      `).run(proposalId, proposal.deliberation_start + 1000);

      const result = manager.castVote(proposalId, 'rVoter0', 'yes', 'tx_v1', now());
      expect(result.success).toBe(true);
    });

    it('rejects double voting', () => {
      const proposal = manager.getProposal(proposalId)!;
      db.prepare(`
        INSERT INTO activity (agent_address, action_type, target_id, tx_hash, content_hash, timestamp)
        VALUES ('rVoter0', 'forum_comment', ?, 'act_d_0', 'h0', ?)
      `).run(proposalId, proposal.deliberation_start + 1000);

      manager.castVote(proposalId, 'rVoter0', 'yes', 'tx_v1', now());
      const result = manager.castVote(proposalId, 'rVoter0', 'no', 'tx_v2', now());
      expect(result.success).toBe(false);
      expect(result.reason).toContain('already voted');
    });

    it('increments vote tallies correctly', () => {
      const proposal = manager.getProposal(proposalId)!;
      // Record deliberation for two voters
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO activity (agent_address, action_type, target_id, tx_hash, content_hash, timestamp)
          VALUES (?, 'forum_comment', ?, ?, ?, ?)
        `).run(`rVoter${i}`, proposalId, `act_d_${i}`, `h${i}`, proposal.deliberation_start + 1000);
      }

      manager.castVote(proposalId, 'rVoter0', 'yes', 'tx_v0', now());
      manager.castVote(proposalId, 'rVoter1', 'no', 'tx_v1', now());

      const updated = manager.getProposal(proposalId)!;
      expect(updated.votes_for).toBe(1);
      expect(updated.votes_against).toBe(1);
      expect(updated.total_voters).toBe(2);
    });
  });

  // --- Vote Resolution ---

  describe('resolveVotes', () => {
    function createVotableProposal(category: 'standard' | 'constitutional' = 'standard'): string {
      manager.setConstitutionRatified(true);
      const pastTime = now() - 15 * 86400; // far in the past
      const result = manager.createProposal('rAuthor', makeProposal({ category }), `tx_${Math.random()}`, pastTime);
      manager.advanceToVoting();

      // Force voting window to be expired
      db.prepare(`UPDATE proposals SET voting_end = ? WHERE proposal_id = ?`).run(now() - 1, result.proposalId);
      return result.proposalId!;
    }

    function addVotes(proposalId: string, yesCount: number, noCount: number): void {
      const proposal = manager.getProposal(proposalId)!;
      let voteIndex = 0;

      for (let i = 0; i < yesCount + noCount; i++) {
        const agent = `rResolver${voteIndex}`;
        seedSeat(agent, `op_res_${voteIndex}`);

        // Record deliberation
        db.prepare(`
          INSERT OR IGNORE INTO activity (agent_address, action_type, target_id, tx_hash, content_hash, timestamp)
          VALUES (?, 'forum_comment', ?, ?, ?, ?)
        `).run(agent, proposalId, `act_res_${voteIndex}`, `h_res_${voteIndex}`, proposal.deliberation_start + 1000);

        // Insert vote directly (bypassing castVote to avoid window checks)
        const vote = i < yesCount ? 'yes' : 'no';
        db.prepare(`
          INSERT INTO votes (proposal_id, agent_address, vote, tx_hash, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(proposalId, agent, vote, `vtx_${voteIndex}`, now());

        voteIndex++;
      }

      // Update tallies
      db.prepare(`UPDATE proposals SET votes_for = ?, votes_against = ?, total_voters = ? WHERE proposal_id = ?`)
        .run(yesCount, noCount, yesCount + noCount, proposalId);
    }

    it('passes standard proposal at 60% with 5+ voters', () => {
      const pid = createVotableProposal();
      addVotes(pid, 4, 2); // 66.7% yes, 6 voters
      const results = manager.resolveVotes();
      const r = results.find(r => r.proposalId === pid);
      expect(r).toBeDefined();
      expect(r!.passed).toBe(true);
    });

    it('fails standard proposal below 60%', () => {
      const pid = createVotableProposal();
      addVotes(pid, 3, 3); // 50% yes
      const results = manager.resolveVotes();
      const r = results.find(r => r.proposalId === pid);
      expect(r!.passed).toBe(false);
    });

    it('fails standard proposal with insufficient voters', () => {
      const pid = createVotableProposal();
      addVotes(pid, 3, 0); // 100% yes but only 3 voters (need 5)
      const results = manager.resolveVotes();
      const r = results.find(r => r.proposalId === pid);
      expect(r!.passed).toBe(false);
    });

    it('passes constitutional proposal at 80% with 8+ voters', () => {
      const pid = createVotableProposal('constitutional');
      addVotes(pid, 8, 1); // 88.9% yes, 9 voters
      const results = manager.resolveVotes();
      const r = results.find(r => r.proposalId === pid);
      expect(r!.passed).toBe(true);
    });

    it('fails constitutional proposal at 75% (below 80% threshold)', () => {
      const pid = createVotableProposal('constitutional');
      addVotes(pid, 6, 2); // 75% yes, 8 voters
      const results = manager.resolveVotes();
      const r = results.find(r => r.proposalId === pid);
      expect(r!.passed).toBe(false);
    });

    it('sets passed proposals to pending execution', () => {
      const pid = createVotableProposal();
      addVotes(pid, 5, 1);
      manager.resolveVotes();
      const proposal = manager.getProposal(pid)!;
      expect(proposal.status).toBe('passed');
      expect(proposal.execution_status).toBe('pending');
    });

    it('sets failed proposals to failed status', () => {
      const pid = createVotableProposal();
      addVotes(pid, 2, 4);
      manager.resolveVotes();
      const proposal = manager.getProposal(pid)!;
      expect(proposal.status).toBe('failed');
    });
  });

  // --- Queries ---

  describe('getProposals / getProposal', () => {
    it('retrieves all proposals', () => {
      manager.setConstitutionRatified(true);
      manager.createProposal('rA', makeProposal({ title: 'P1' }), 'tx_1', now());
      manager.createProposal('rA', makeProposal({ title: 'P2' }), 'tx_2', now());
      const all = manager.getProposals();
      expect(all).toHaveLength(2);
    });

    it('filters by status', () => {
      manager.setConstitutionRatified(true);
      manager.createProposal('rA', makeProposal(), 'tx_1', now());
      const deliberating = manager.getProposals('deliberation');
      expect(deliberating).toHaveLength(1);
      const voting = manager.getProposals('voting');
      expect(voting).toHaveLength(0);
    });

    it('returns undefined for non-existent proposal', () => {
      expect(manager.getProposal('nonexistent')).toBeUndefined();
    });
  });

  // --- Stalled Executions ---

  describe('checkStalledExecutions', () => {
    it('detects proposals passed but pending > 7 days', () => {
      manager.setConstitutionRatified(true);
      const oldTime = now() - 20 * 86400;
      const result = manager.createProposal('rA', makeProposal(), 'tx_1', oldTime);
      const pid = result.proposalId!;

      // Manually advance to passed/pending
      db.prepare(`UPDATE proposals SET status = 'passed', execution_status = 'pending', voting_end = ? WHERE proposal_id = ?`)
        .run(now() - 8 * 86400, pid);

      const stalled = manager.checkStalledExecutions();
      expect(stalled).toHaveLength(1);
      expect(stalled[0].proposal_id).toBe(pid);
    });
  });
});
