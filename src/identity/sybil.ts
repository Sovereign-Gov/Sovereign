import { Client } from 'xrpl';
import { getDb } from '../db/database';
import { config } from '../config';

/**
 * Sybil detection — multi-signal scoring to detect duplicate operators.
 *
 * Signals:
 * 1. Funding chain analysis (XRP origin within 3 hops)
 * 2. Vote correlation scoring between agents
 * 3. Heartbeat timing correlation
 * 4. Infrastructure fingerprinting from memo data
 *
 * Score: 0-100. Auto-challenge trigger at > 60.
 */

export interface SybilReport {
  agentAddress: string;
  overallScore: number;
  signals: {
    fundingChain: number;     // 0-100
    voteCorrelation: number;  // 0-100
    heartbeatTiming: number;  // 0-100
    infraFingerprint: number; // 0-100
  };
  flaggedPairs: string[];     // addresses with high correlation
  timestamp: number;
  autoChallenge: boolean;
}

interface FundingHop {
  from: string;
  to: string;
  amount: string;
  txHash: string;
}

export class SybilDetector {
  private client: Client;
  private challengeThreshold: number;

  constructor(client: Client, challengeThreshold = 60) {
    this.client = client;
    this.challengeThreshold = challengeThreshold;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sybil_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_address TEXT NOT NULL,
        overall_score INTEGER NOT NULL,
        funding_score INTEGER NOT NULL,
        vote_score INTEGER NOT NULL,
        heartbeat_score INTEGER NOT NULL,
        infra_score INTEGER NOT NULL,
        flagged_pairs TEXT NOT NULL DEFAULT '[]',
        auto_challenge INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sybil_agent ON sybil_reports(agent_address);
      CREATE INDEX IF NOT EXISTS idx_sybil_score ON sybil_reports(overall_score);
    `);
  }

  /**
   * Run full Sybil analysis on an agent. Returns scored report.
   */
  async analyze(agentAddress: string): Promise<SybilReport> {
    const activeAgents = this.getActiveAgents().filter(a => a !== agentAddress);

    const [fundingScore, fundingPairs] = await this.analyzeFundingChain(agentAddress, activeAgents);
    const [voteScore, votePairs] = this.analyzeVoteCorrelation(agentAddress, activeAgents);
    const [heartbeatScore, hbPairs] = this.analyzeHeartbeatTiming(agentAddress, activeAgents);
    const [infraScore, infraPairs] = this.analyzeInfraFingerprint(agentAddress, activeAgents);

    // Weighted average: funding chain is strongest signal
    const overallScore = Math.round(
      fundingScore * 0.35 +
      voteScore * 0.25 +
      heartbeatScore * 0.20 +
      infraScore * 0.20
    );

    const allPairs = [...new Set([...fundingPairs, ...votePairs, ...hbPairs, ...infraPairs])];
    const autoChallenge = overallScore > this.challengeThreshold;

    const report: SybilReport = {
      agentAddress,
      overallScore,
      signals: {
        fundingChain: fundingScore,
        voteCorrelation: voteScore,
        heartbeatTiming: heartbeatScore,
        infraFingerprint: infraScore,
      },
      flaggedPairs: allPairs,
      timestamp: Math.floor(Date.now() / 1000),
      autoChallenge,
    };

    // Persist report
    const db = getDb();
    db.prepare(`
      INSERT INTO sybil_reports (agent_address, overall_score, funding_score, vote_score, heartbeat_score, infra_score, flagged_pairs, auto_challenge)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentAddress, overallScore, fundingScore, voteScore,
      heartbeatScore, infraScore, JSON.stringify(allPairs), autoChallenge ? 1 : 0
    );

    if (autoChallenge) {
      console.log(`[SYBIL] ⚠️ Auto-challenge triggered for ${agentAddress} (score: ${overallScore})`);
    } else {
      console.log(`[SYBIL] ${agentAddress}: score=${overallScore} (fund=${fundingScore} vote=${voteScore} hb=${heartbeatScore} infra=${infraScore})`);
    }

    return report;
  }

  /**
   * Run analysis on all active agents
   */
  async analyzeAll(): Promise<SybilReport[]> {
    const agents = this.getActiveAgents();
    const reports: SybilReport[] = [];
    for (const agent of agents) {
      const report = await this.analyze(agent);
      reports.push(report);
    }
    return reports;
  }

  /**
   * Get latest Sybil report for an agent
   */
  getLatestReport(agentAddress: string): SybilReport | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM sybil_reports WHERE agent_address = ? ORDER BY created_at DESC LIMIT 1
    `).get(agentAddress) as any;

    if (!row) return null;

    return {
      agentAddress: row.agent_address,
      overallScore: row.overall_score,
      signals: {
        fundingChain: row.funding_score,
        voteCorrelation: row.vote_score,
        heartbeatTiming: row.heartbeat_score,
        infraFingerprint: row.infra_score,
      },
      flaggedPairs: JSON.parse(row.flagged_pairs),
      timestamp: row.created_at,
      autoChallenge: !!row.auto_challenge,
    };
  }

  /**
   * Get agents flagged above threshold
   */
  getFlaggedAgents(): SybilReport[] {
    const db = getDb();
    // Latest report per agent above threshold
    const rows = db.prepare(`
      SELECT sr.* FROM sybil_reports sr
      INNER JOIN (
        SELECT agent_address, MAX(created_at) as latest
        FROM sybil_reports GROUP BY agent_address
      ) latest ON sr.agent_address = latest.agent_address AND sr.created_at = latest.latest
      WHERE sr.overall_score > ?
      ORDER BY sr.overall_score DESC
    `).all(this.challengeThreshold) as any[];

    return rows.map(row => ({
      agentAddress: row.agent_address,
      overallScore: row.overall_score,
      signals: {
        fundingChain: row.funding_score,
        voteCorrelation: row.vote_score,
        heartbeatTiming: row.heartbeat_score,
        infraFingerprint: row.infra_score,
      },
      flaggedPairs: JSON.parse(row.flagged_pairs),
      timestamp: row.created_at,
      autoChallenge: !!row.auto_challenge,
    }));
  }

  // --- Signal analyzers ---

  /**
   * Signal 1: Funding chain analysis.
   * Trace XRP origin within 3 hops. Shared funding source = high Sybil signal.
   */
  private async analyzeFundingChain(
    agent: string,
    others: string[]
  ): Promise<[number, string[]]> {
    const flagged: string[] = [];
    let score = 0;

    try {
      const agentFunders = await this.traceFunding(agent, 3);
      const agentSources = new Set(agentFunders.map(h => h.from));

      for (const other of others) {
        const otherFunders = await this.traceFunding(other, 3);
        const otherSources = new Set(otherFunders.map(h => h.from));

        // Check overlap
        const overlap = [...agentSources].filter(s => otherSources.has(s));
        if (overlap.length > 0) {
          flagged.push(other);
          // Score by hop proximity — closer common funder = higher score
          const minHopAgent = Math.min(...agentFunders.filter(h => overlap.includes(h.from)).map((_, i) => i + 1));
          const hopScore = Math.max(0, 100 - (minHopAgent - 1) * 30); // hop1=100, hop2=70, hop3=40
          score = Math.max(score, hopScore);
        }
      }
    } catch (err) {
      console.warn(`[SYBIL] Funding chain analysis failed for ${agent}:`, err);
    }

    return [score, flagged];
  }

  /**
   * Trace funding chain for an account up to N hops back
   */
  private async traceFunding(address: string, maxHops: number): Promise<FundingHop[]> {
    const hops: FundingHop[] = [];
    let current = address;

    for (let hop = 0; hop < maxHops; hop++) {
      try {
        const response = await this.client.request({
          command: 'account_tx',
          account: current,
          limit: 50,
        });

        // Find the earliest incoming payment
        const txs = response.result.transactions || [];
        let earliest: FundingHop | null = null;

        for (const entry of txs) {
          const tx = entry.tx as any;
          if (!tx) continue;
          if (tx.TransactionType === 'Payment' && tx.Destination === current && tx.Account !== current) {
            const amount = typeof tx.Amount === 'string' ? tx.Amount : '0';
            if (!earliest || (tx.date && (!earliest as any))) {
              earliest = {
                from: tx.Account,
                to: current,
                amount,
                txHash: tx.hash || '',
              };
            }
          }
        }

        if (!earliest) break;
        hops.push(earliest);
        current = earliest.from;
      } catch {
        break; // Account may not exist or be unreachable
      }
    }

    return hops;
  }

  /**
   * Signal 2: Vote correlation scoring.
   * Agents that always vote identically are suspicious.
   */
  private analyzeVoteCorrelation(
    agent: string,
    others: string[]
  ): [number, string[]] {
    const db = getDb();
    const flagged: string[] = [];
    let maxScore = 0;

    // Get agent's votes
    const agentVotes = db.prepare(`
      SELECT proposal_id, vote FROM votes WHERE agent_address = ?
    `).all(agent) as { proposal_id: string; vote: string }[];

    if (agentVotes.length < 3) return [0, []]; // Not enough data

    const agentVoteMap = new Map(agentVotes.map(v => [v.proposal_id, v.vote]));

    for (const other of others) {
      const otherVotes = db.prepare(`
        SELECT proposal_id, vote FROM votes WHERE agent_address = ?
      `).all(other) as { proposal_id: string; vote: string }[];

      // Find common proposals
      let matches = 0;
      let total = 0;
      for (const ov of otherVotes) {
        if (agentVoteMap.has(ov.proposal_id)) {
          total++;
          if (agentVoteMap.get(ov.proposal_id) === ov.vote) matches++;
        }
      }

      if (total >= 3) {
        const correlation = matches / total;
        if (correlation >= 0.9) {
          flagged.push(other);
          const score = Math.round(correlation * 100);
          maxScore = Math.max(maxScore, score);
        }
      }
    }

    return [maxScore, flagged];
  }

  /**
   * Signal 3: Heartbeat timing correlation.
   * Agents with suspiciously synchronized heartbeat patterns.
   */
  private analyzeHeartbeatTiming(
    agent: string,
    others: string[]
  ): [number, string[]] {
    const db = getDb();
    const flagged: string[] = [];
    let maxScore = 0;

    // Get agent's heartbeat timestamps
    const agentHBs = db.prepare(`
      SELECT timestamp FROM heartbeats WHERE agent_address = ? ORDER BY timestamp ASC
    `).all(agent) as { timestamp: number }[];

    if (agentHBs.length < 5) return [0, []]; // Not enough data

    for (const other of others) {
      const otherHBs = db.prepare(`
        SELECT timestamp FROM heartbeats WHERE agent_address = ? ORDER BY timestamp ASC
      `).all(other) as { timestamp: number }[];

      if (otherHBs.length < 5) continue;

      // Calculate time deltas between paired heartbeats
      const deltas: number[] = [];
      let j = 0;
      for (const ahb of agentHBs) {
        // Find closest other heartbeat
        while (j < otherHBs.length - 1 && Math.abs(otherHBs[j + 1].timestamp - ahb.timestamp) < Math.abs(otherHBs[j].timestamp - ahb.timestamp)) {
          j++;
        }
        if (j < otherHBs.length) {
          deltas.push(Math.abs(otherHBs[j].timestamp - ahb.timestamp));
        }
      }

      if (deltas.length < 5) continue;

      // If median delta is under 60 seconds, highly suspicious
      const sorted = [...deltas].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      let score = 0;
      if (median < 30) score = 95;       // < 30s: almost certainly same infra
      else if (median < 60) score = 80;   // < 1min: very suspicious
      else if (median < 300) score = 50;  // < 5min: somewhat suspicious
      else if (median < 600) score = 20;  // < 10min: slightly notable

      if (score > 40) {
        flagged.push(other);
        maxScore = Math.max(maxScore, score);
      }
    }

    return [maxScore, flagged];
  }

  /**
   * Signal 4: Infrastructure fingerprinting from memo data.
   * Detect shared infrastructure patterns (same libraries, same formatting, etc.)
   */
  private analyzeInfraFingerprint(
    agent: string,
    others: string[]
  ): [number, string[]] {
    const db = getDb();
    const flagged: string[] = [];
    let maxScore = 0;

    // Extract memo content patterns for agent
    const agentMemos = db.prepare(`
      SELECT content_hash, content_text FROM forum_posts WHERE author_address = ? LIMIT 50
    `).all(agent) as { content_hash: string; content_text: string | null }[];

    if (agentMemos.length < 3) return [0, []];

    const agentPatterns = this.extractPatterns(agentMemos);

    for (const other of others) {
      const otherMemos = db.prepare(`
        SELECT content_hash, content_text FROM forum_posts WHERE author_address = ? LIMIT 50
      `).all(other) as { content_hash: string; content_text: string | null }[];

      if (otherMemos.length < 3) continue;

      const otherPatterns = this.extractPatterns(otherMemos);

      // Compare patterns
      const similarity = this.patternSimilarity(agentPatterns, otherPatterns);
      if (similarity > 0.7) {
        flagged.push(other);
        const score = Math.round(similarity * 100);
        maxScore = Math.max(maxScore, score);
      }
    }

    return [maxScore, flagged];
  }

  /**
   * Extract writing/formatting patterns from posts
   */
  private extractPatterns(posts: { content_text: string | null }[]): Map<string, number> {
    const patterns = new Map<string, number>();

    for (const post of posts) {
      if (!post.content_text) continue;
      const text = post.content_text;

      // Pattern: average sentence length bucket
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      const avgLen = sentences.length > 0 ? Math.round(sentences.reduce((a, s) => a + s.trim().split(/\s+/).length, 0) / sentences.length / 5) * 5 : 0;
      patterns.set(`avg_sentence_len:${avgLen}`, (patterns.get(`avg_sentence_len:${avgLen}`) || 0) + 1);

      // Pattern: uses markdown headers
      if (/^#{1,3}\s/m.test(text)) patterns.set('uses_md_headers', (patterns.get('uses_md_headers') || 0) + 1);

      // Pattern: uses bullet points
      if (/^[-*]\s/m.test(text)) patterns.set('uses_bullets', (patterns.get('uses_bullets') || 0) + 1);

      // Pattern: uses code blocks
      if (/```/.test(text)) patterns.set('uses_code_blocks', (patterns.get('uses_code_blocks') || 0) + 1);

      // Pattern: typical paragraph count
      const paragraphs = text.split(/\n\n+/).length;
      const pBucket = Math.round(paragraphs / 2) * 2;
      patterns.set(`para_count:${pBucket}`, (patterns.get(`para_count:${pBucket}`) || 0) + 1);
    }

    return patterns;
  }

  /**
   * Compute Jaccard-like similarity between pattern sets
   */
  private patternSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    const allKeys = new Set([...a.keys(), ...b.keys()]);
    if (allKeys.size === 0) return 0;

    let intersection = 0;
    for (const key of allKeys) {
      if (a.has(key) && b.has(key)) intersection++;
    }

    return intersection / allKeys.size;
  }

  // --- Helpers ---

  private getActiveAgents(): string[] {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`
      SELECT agent_address FROM seats WHERE status = 'active' AND term_end > ?
    `).all(now) as { agent_address: string }[];
    return rows.map(r => r.agent_address);
  }
}
