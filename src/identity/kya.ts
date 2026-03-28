import { getDb } from '../db/database';

/**
 * KYA (Know Your Agent) identity verification via t54 protocol.
 * Verifies agent operator identity and enforces one-operator-one-seat rule.
 *
 * NOTE: t54 API endpoints are placeholders — fill in real URLs when available.
 */

export interface KyaVerification {
  operatorId: string;
  agentAddress: string;
  verified: boolean;
  verifiedAt: number | null;
  score: number; // 0-100 identity confidence
  attestations: string[];
}

export interface T54OperatorProfile {
  operatorId: string;
  displayName: string;
  verificationLevel: 'none' | 'basic' | 'enhanced' | 'full';
  linkedAgents: string[];
  createdAt: number;
}

// Placeholder t54 API config — replace with real endpoints
const T54_CONFIG = {
  baseUrl: process.env.T54_API_URL || 'https://api.t54.io/v1', // placeholder
  apiKey: process.env.T54_API_KEY || '',
};

export class KyaManager {

  constructor() {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS kya_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id TEXT NOT NULL,
        agent_address TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        score INTEGER NOT NULL DEFAULT 0,
        attestations TEXT NOT NULL DEFAULT '[]',
        last_checked INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        UNIQUE(operator_id, agent_address)
      );

      CREATE INDEX IF NOT EXISTS idx_kya_operator ON kya_verifications(operator_id);
      CREATE INDEX IF NOT EXISTS idx_kya_agent ON kya_verifications(agent_address);
    `);
  }

  /**
   * Verify an operator's identity via t54.
   * Returns verification result with confidence score.
   */
  async verifyOperator(operatorId: string, agentAddress: string): Promise<KyaVerification> {
    // Check cached verification first
    const cached = this.getCachedVerification(operatorId, agentAddress);
    if (cached && cached.verified && this.isRecent(cached.verifiedAt, 7 * 86400)) {
      return cached;
    }

    // Query t54 API
    let profile: T54OperatorProfile | null = null;
    try {
      profile = await this.fetchT54Profile(operatorId);
    } catch (err) {
      console.warn(`[KYA] t54 API call failed for ${operatorId}:`, err);
    }

    // Build verification result
    const verification: KyaVerification = {
      operatorId,
      agentAddress,
      verified: false,
      verifiedAt: null,
      score: 0,
      attestations: [],
    };

    if (profile) {
      // Score based on verification level
      switch (profile.verificationLevel) {
        case 'full':
          verification.score = 100;
          verification.verified = true;
          break;
        case 'enhanced':
          verification.score = 75;
          verification.verified = true;
          break;
        case 'basic':
          verification.score = 50;
          verification.verified = true;
          break;
        case 'none':
        default:
          verification.score = 10;
          verification.verified = false;
          break;
      }
      verification.verifiedAt = Math.floor(Date.now() / 1000);
      verification.attestations.push(`t54:${profile.verificationLevel}`);
    }

    // Cache result
    this.cacheVerification(verification);

    console.log(`[KYA] Operator ${operatorId}: score=${verification.score}, verified=${verification.verified}`);
    return verification;
  }

  /**
   * Check one-operator-one-seat rule.
   * Returns true if the operator does NOT already hold another active seat.
   */
  checkOneOperatorOneSeat(operatorId: string, excludeAgent?: string): boolean {
    const db = getDb();
    let query = `
      SELECT COUNT(*) as count FROM seats
      WHERE operator_id = ? AND status = 'active' AND term_end > ?
    `;
    const params: any[] = [operatorId, Math.floor(Date.now() / 1000)];

    if (excludeAgent) {
      query += ' AND agent_address != ?';
      params.push(excludeAgent);
    }

    const result = db.prepare(query).get(...params) as { count: number };
    return result.count === 0;
  }

  /**
   * Get all agents linked to an operator
   */
  getOperatorAgents(operatorId: string): string[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT agent_address FROM seats WHERE operator_id = ? AND status = 'active'
    `).all(operatorId) as { agent_address: string }[];
    return rows.map(r => r.agent_address);
  }

  /**
   * Get verification status for an agent
   */
  getVerification(agentAddress: string): KyaVerification | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM kya_verifications WHERE agent_address = ? ORDER BY last_checked DESC LIMIT 1
    `).get(agentAddress) as any;

    if (!row) return null;

    return {
      operatorId: row.operator_id,
      agentAddress: row.agent_address,
      verified: !!row.verified,
      verifiedAt: row.verified_at,
      score: row.score,
      attestations: JSON.parse(row.attestations),
    };
  }

  /**
   * Bulk verify all active seat holders (periodic check)
   */
  async verifyAllActive(): Promise<{ verified: number; unverified: number }> {
    const db = getDb();
    const seats = db.prepare(`
      SELECT agent_address, operator_id FROM seats WHERE status = 'active'
    `).all() as { agent_address: string; operator_id: string }[];

    let verified = 0;
    let unverified = 0;

    for (const seat of seats) {
      const result = await this.verifyOperator(seat.operator_id, seat.agent_address);
      if (result.verified) verified++;
      else unverified++;
    }

    console.log(`[KYA] Bulk verify: ${verified} verified, ${unverified} unverified out of ${seats.length}`);
    return { verified, unverified };
  }

  // --- Private helpers ---

  private getCachedVerification(operatorId: string, agentAddress: string): KyaVerification | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM kya_verifications WHERE operator_id = ? AND agent_address = ?
    `).get(operatorId, agentAddress) as any;

    if (!row) return null;

    return {
      operatorId: row.operator_id,
      agentAddress: row.agent_address,
      verified: !!row.verified,
      verifiedAt: row.verified_at,
      score: row.score,
      attestations: JSON.parse(row.attestations),
    };
  }

  private cacheVerification(v: KyaVerification): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO kya_verifications (operator_id, agent_address, verified, verified_at, score, attestations, last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operator_id, agent_address) DO UPDATE SET
        verified = excluded.verified,
        verified_at = excluded.verified_at,
        score = excluded.score,
        attestations = excluded.attestations,
        last_checked = excluded.last_checked
    `).run(
      v.operatorId,
      v.agentAddress,
      v.verified ? 1 : 0,
      v.verifiedAt,
      v.score,
      JSON.stringify(v.attestations),
      Math.floor(Date.now() / 1000)
    );
  }

  private isRecent(timestamp: number | null, maxAgeSeconds: number): boolean {
    if (!timestamp) return false;
    return (Math.floor(Date.now() / 1000) - timestamp) < maxAgeSeconds;
  }

  /**
   * Fetch operator profile from t54 API.
   * PLACEHOLDER — replace with real API integration.
   */
  private async fetchT54Profile(operatorId: string): Promise<T54OperatorProfile | null> {
    if (!T54_CONFIG.apiKey) {
      console.warn('[KYA] t54 API key not configured — returning null');
      return null;
    }

    const url = `${T54_CONFIG.baseUrl}/operators/${encodeURIComponent(operatorId)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${T54_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`t54 API returned ${res.status}`);
    }

    return await res.json() as T54OperatorProfile;
  }
}
