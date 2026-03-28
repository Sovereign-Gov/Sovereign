import { getDb } from '../db/database';
import { config } from '../config';

export interface ProposalData {
  title: string;
  descriptionHash: string;
  category: 'standard' | 'constitutional' | 'treasury_spend';
  amount?: string;
  destination?: string;
}

export interface ProposalInfo {
  id: number;
  proposal_id: string;
  author_address: string;
  title: string;
  description_hash: string;
  category: string;
  amount: string | null;
  destination: string | null;
  status: string;
  deliberation_start: number;
  deliberation_end: number;
  voting_start: number | null;
  voting_end: number | null;
  votes_for: number;
  votes_against: number;
  total_voters: number;
  execution_status: string | null;
  tx_hash: string;
}

export class ProposalManager {
  private constitutionRatified = false;

  setConstitutionRatified(ratified: boolean): void {
    this.constitutionRatified = ratified;
  }

  /**
   * Create a new proposal
   */
  createProposal(
    author: string,
    data: ProposalData,
    txHash: string,
    timestamp: number
  ): { success: boolean; reason?: string; proposalId?: string } {
    // Check constitution lock — only constitutional ratification allowed before constitution
    if (!this.constitutionRatified && data.category !== 'constitutional') {
      return { success: false, reason: 'Governance locked until constitution is ratified' };
    }

    const db = getDb();
    const proposalId = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const deliberationDays = Math.max(
      config.governance.deliberationMinDays,
      data.category === 'constitutional' ? 14 : 7
    );
    const deliberationEnd = timestamp + (deliberationDays * 24 * 60 * 60);

    db.prepare(`
      INSERT INTO proposals (
        proposal_id, author_address, title, description_hash, category,
        amount, destination, status, deliberation_start, deliberation_end, tx_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'deliberation', ?, ?, ?)
    `).run(
      proposalId, author, data.title, data.descriptionHash,
      data.category, data.amount || null, data.destination || null,
      timestamp, deliberationEnd, txHash
    );

    console.log(`[PROPOSALS] Created ${proposalId}: "${data.title}" by ${author} — deliberation ends ${new Date(deliberationEnd * 1000).toISOString()}`);

    return { success: true, proposalId };
  }

  /**
   * Advance proposals from deliberation to voting
   */
  advanceToVoting(): string[] {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const votingHours = config.governance.votingPeriodHours;

    const ready = db.prepare(`
      SELECT proposal_id FROM proposals
      WHERE status = 'deliberation' AND deliberation_end <= ?
    `).all(now) as { proposal_id: string }[];

    for (const p of ready) {
      const votingEnd = now + (votingHours * 60 * 60);
      db.prepare(`
        UPDATE proposals SET status = 'voting', voting_start = ?, voting_end = ?
        WHERE proposal_id = ?
      `).run(now, votingEnd, p.proposal_id);
      console.log(`[PROPOSALS] ${p.proposal_id} moved to voting — ends ${new Date(votingEnd * 1000).toISOString()}`);
    }

    return ready.map(p => p.proposal_id);
  }

  /**
   * Cast a vote
   */
  castVote(
    proposalId: string,
    agent: string,
    vote: 'yes' | 'no',
    txHash: string,
    timestamp: number
  ): { success: boolean; reason?: string } {
    const db = getDb();

    // Check proposal is in voting phase
    const proposal = db.prepare(`
      SELECT * FROM proposals WHERE proposal_id = ? AND status = 'voting'
    `).get(proposalId) as ProposalInfo | undefined;

    if (!proposal) {
      return { success: false, reason: 'Proposal not in voting phase' };
    }

    // Check voting window
    if (proposal.voting_end && timestamp > proposal.voting_end) {
      return { success: false, reason: 'Voting window closed' };
    }

    // Check agent hasn't already voted
    const existing = db.prepare(`
      SELECT id FROM votes WHERE proposal_id = ? AND agent_address = ?
    `).get(proposalId, agent);
    if (existing) {
      return { success: false, reason: 'Agent already voted on this proposal' };
    }

    // Check agent participated in deliberation
    const participated = db.prepare(`
      SELECT id FROM activity
      WHERE agent_address = ? AND action_type = 'forum_comment'
      AND target_id = ? AND timestamp >= ? AND timestamp <= ?
    `).get(agent, proposalId, proposal.deliberation_start, proposal.deliberation_end);

    if (!participated) {
      return { success: false, reason: 'Agent did not participate in deliberation — must comment before voting' };
    }

    // Record vote
    db.prepare(`
      INSERT INTO votes (proposal_id, agent_address, vote, tx_hash, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(proposalId, agent, vote, txHash, timestamp);

    // Update proposal tallies
    if (vote === 'yes') {
      db.prepare(`UPDATE proposals SET votes_for = votes_for + 1, total_voters = total_voters + 1 WHERE proposal_id = ?`).run(proposalId);
    } else {
      db.prepare(`UPDATE proposals SET votes_against = votes_against + 1, total_voters = total_voters + 1 WHERE proposal_id = ?`).run(proposalId);
    }

    console.log(`[PROPOSALS] Vote on ${proposalId}: ${agent} voted ${vote}`);
    return { success: true };
  }

  /**
   * Resolve completed votes
   */
  resolveVotes(): Array<{ proposalId: string; passed: boolean }> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const results: Array<{ proposalId: string; passed: boolean }> = [];

    const ended = db.prepare(`
      SELECT * FROM proposals WHERE status = 'voting' AND voting_end <= ?
    `).all(now) as ProposalInfo[];

    for (const p of ended) {
      const totalVotes = p.votes_for + p.votes_against;
      const forPercent = totalVotes > 0 ? p.votes_for / totalVotes : 0;

      let passed = false;
      let minVoters: number;
      let threshold: number;

      if (p.category === 'constitutional') {
        minVoters = config.governance.minVotersConstitutional;
        threshold = config.governance.constitutionalPassThreshold;
      } else {
        minVoters = config.governance.minVotersStandard;
        threshold = config.governance.standardPassThreshold;
      }

      if (p.total_voters >= minVoters && forPercent >= threshold) {
        passed = true;
        db.prepare(`UPDATE proposals SET status = 'passed', execution_status = 'pending' WHERE proposal_id = ?`).run(p.proposal_id);
        console.log(`[PROPOSALS] ${p.proposal_id} PASSED (${(forPercent * 100).toFixed(1)}% for, ${p.total_voters} voters)`);
      } else {
        db.prepare(`UPDATE proposals SET status = 'failed' WHERE proposal_id = ?`).run(p.proposal_id);
        const reason = p.total_voters < minVoters ? 'quorum not met' : 'threshold not met';
        console.log(`[PROPOSALS] ${p.proposal_id} FAILED — ${reason} (${(forPercent * 100).toFixed(1)}% for, ${p.total_voters} voters)`);
      }

      results.push({ proposalId: p.proposal_id, passed });
    }

    return results;
  }

  /**
   * Get all proposals by status
   */
  getProposals(status?: string): ProposalInfo[] {
    const db = getDb();
    if (status) {
      return db.prepare(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC`).all(status) as ProposalInfo[];
    }
    return db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all() as ProposalInfo[];
  }

  /**
   * Get a specific proposal
   */
  getProposal(proposalId: string): ProposalInfo | undefined {
    const db = getDb();
    return db.prepare(`SELECT * FROM proposals WHERE proposal_id = ?`).get(proposalId) as ProposalInfo | undefined;
  }

  /**
   * Check for stalled executions (passed but pending > 7 days)
   */
  checkStalledExecutions(): ProposalInfo[] {
    const db = getDb();
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    return db.prepare(`
      SELECT * FROM proposals
      WHERE status = 'passed' AND execution_status = 'pending'
      AND voting_end <= ?
    `).all(sevenDaysAgo) as ProposalInfo[];
  }
}
