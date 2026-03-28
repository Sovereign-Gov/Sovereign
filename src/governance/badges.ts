import { Client, Wallet } from 'xrpl';
import type { NFTokenMint } from 'xrpl';
import { NFTokenMintFlags } from 'xrpl';
import { getDb } from '../db/database';
import { hexEncode } from '../utils/xrpl-helpers';

export interface BadgeData {
  type: 'genesis' | 'council' | 'steward' | 'arbiter' | 'special';
  term: number;
  name: string;
  role: string;
  seatNumber: number;
  termStart: number;
  termEnd: number;
  proposalsVoted: string;
  deliberationRate: string;
  daysServed: number;
  fullTerm: boolean;
  collection: string;
}

export interface BadgeRecord {
  id: number;
  agent_address: string;
  badge_type: string;
  term_number: number;
  metadata_json: string;
  claimed: number;
  claim_tx_hash: string | null;
  nft_token_id: string | null;
  created_at: number;
}

/**
 * Badge NFT Manager — commemorative NFT badges earned per term.
 * Badges are created as claimable records; agents claim them to mint on-chain NFTs.
 */
export class BadgeManager {
  private client: Client;
  private wallet: Wallet | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  /** Set the minting wallet */
  setWallet(wallet: Wallet): void {
    this.wallet = wallet;
  }

  /**
   * Create a claimable badge record when a term ends.
   */
  createClaimableBadge(agentAddress: string, badgeData: BadgeData): { badgeId: number } {
    const db = getDb();
    const metadataJson = JSON.stringify({
      ...badgeData,
      originalHolder: agentAddress,
      issuedBy: 'Sovereign Governance',
      standard: 'XLS-20',
      createdAt: Math.floor(Date.now() / 1000),
    });

    const result = db.prepare(`
      INSERT INTO badges (agent_address, badge_type, term_number, metadata_json, claimed, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(
      agentAddress,
      badgeData.type,
      badgeData.term,
      metadataJson,
      Math.floor(Date.now() / 1000),
    );

    const badgeId = Number(result.lastInsertRowid);
    console.log(`[BADGES] Claimable badge created: #${badgeId} for ${agentAddress} (${badgeData.type}, term ${badgeData.term})`);

    return { badgeId };
  }

  /**
   * Agent claims their badge — mints an NFT on-chain.
   * - Verify badge belongs to this agent
   * - Verify not already claimed
   * - Mint NFT: tfTransferable ON, tfBurnable OFF
   * - URI pointing to metadata (Arweave or equivalent)
   */
  async claimBadge(
    agentAddress: string,
    badgeId: number,
    txHash: string
  ): Promise<{ nftTokenId: string }> {
    if (!this.wallet) throw new Error('Wallet not set — call setWallet() first');

    const db = getDb();
    const badge = db.prepare(
      `SELECT * FROM badges WHERE id = ?`
    ).get(badgeId) as BadgeRecord | undefined;

    if (!badge) throw new Error(`Badge #${badgeId} not found`);
    if (badge.agent_address !== agentAddress) {
      throw new Error(`Badge #${badgeId} does not belong to ${agentAddress}`);
    }
    if (badge.claimed) {
      throw new Error(`Badge #${badgeId} already claimed`);
    }

    // Build metadata URI — use Arweave-style URI or a local gateway
    // In production this would upload to Arweave first; for now, encode inline
    const metadataUri = `https://sovereign.gov/api/badges/metadata/${badgeId}`;
    const uriHex = hexEncode(metadataUri);

    // Mint NFT
    const mintTx: NFTokenMint = {
      TransactionType: 'NFTokenMint',
      Account: this.wallet.address,
      NFTokenTaxon: 1, // Badge collection taxon
      Flags: NFTokenMintFlags.tfTransferable, // Transferable ON, Burnable OFF
      URI: uriHex,
      Destination: agentAddress,
    };

    const prepared = await this.client.autofill(mintTx);
    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);

    const meta = result.result.meta as any;
    const nftTokenId: string | undefined = meta?.nftoken_id;
    if (!nftTokenId) {
      throw new Error('NFT mint succeeded but no token ID returned');
    }

    // Update badge record
    db.prepare(`
      UPDATE badges SET claimed = 1, claim_tx_hash = ?, nft_token_id = ? WHERE id = ?
    `).run(txHash, nftTokenId, badgeId);

    console.log(`[BADGES] Badge #${badgeId} claimed by ${agentAddress} → NFT ${nftTokenId}`);

    return { nftTokenId };
  }

  /**
   * List unclaimed badges for an agent.
   */
  getClaimableBadges(agentAddress: string): BadgeRecord[] {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM badges WHERE agent_address = ? AND claimed = 0 ORDER BY created_at DESC`
    ).all(agentAddress) as BadgeRecord[];
  }

  /**
   * List all badges (claimed + unclaimed) for an agent.
   */
  getAgentBadges(agentAddress: string): BadgeRecord[] {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM badges WHERE agent_address = ? ORDER BY created_at DESC`
    ).all(agentAddress) as BadgeRecord[];
  }

  /**
   * Get a specific badge by ID.
   */
  getBadge(badgeId: number): BadgeRecord | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM badges WHERE id = ?`
    ).get(badgeId) as BadgeRecord | undefined;
  }
}
