import { Client, Payment, Wallet, multisign, xrpToDrops, dropsToXrp } from 'xrpl';
import type { Transaction, SignerEntry } from 'xrpl';
import { getDb } from '../db/database';
import { config } from '../config';

/**
 * Multi-sign coordinator for XRPL governance transactions.
 *
 * Handles:
 * - Creating multi-sign transactions (treasury spends, stake refunds, signer rotation)
 * - Tracking pending signatures from council members
 * - Submitting when quorum is reached
 */

export interface PendingMultiSign {
  id: number;
  txId: string;
  txType: 'treasury_spend' | 'stake_refund' | 'signer_rotation' | 'generic';
  txJson: string;           // serialized unsigned transaction
  description: string;
  proposalId: string | null; // linked governance proposal
  requiredSigners: number;
  collectedSigners: number;
  status: 'pending' | 'ready' | 'submitted' | 'failed' | 'expired';
  submittedHash: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CollectedSignature {
  txId: string;
  signerAddress: string;
  signedTxBlob: string;
  timestamp: number;
}

export class MultiSignCoordinator {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS multisign_txs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id TEXT NOT NULL UNIQUE,
        tx_type TEXT NOT NULL,
        tx_json TEXT NOT NULL,
        description TEXT NOT NULL,
        proposal_id TEXT,
        required_signers INTEGER NOT NULL,
        collected_signers INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_hash TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multisign_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id TEXT NOT NULL,
        signer_address TEXT NOT NULL,
        signed_tx_blob TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        UNIQUE(tx_id, signer_address)
      );

      CREATE INDEX IF NOT EXISTS idx_multisign_status ON multisign_txs(status);
      CREATE INDEX IF NOT EXISTS idx_multisign_proposal ON multisign_txs(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_multisign_sigs ON multisign_signatures(tx_id);
    `);
  }

  /**
   * Create a treasury spend multi-sign transaction.
   */
  async createTreasurySpend(params: {
    destination: string;
    amountDrops: string;
    description: string;
    proposalId: string;
    quorum: number;
  }): Promise<{ txId: string; txJson: object }> {
    const prepared = await this.client.autofill({
      TransactionType: 'Payment',
      Account: config.xrpl.treasuryAddress,
      Destination: params.destination,
      Amount: params.amountDrops,
      Memos: [{
        Memo: {
          MemoType: Buffer.from('sovereign/treasury_spend').toString('hex').toUpperCase(),
          MemoData: Buffer.from(JSON.stringify({
            proposalId: params.proposalId,
            description: params.description,
          })).toString('hex').toUpperCase(),
        },
      }],
    } as Payment);

    // Set SigningPubKey to empty for multi-sign
    (prepared as any).SigningPubKey = '';

    const txId = await this.storePendingTx({
      txType: 'treasury_spend',
      txJson: prepared,
      description: params.description,
      proposalId: params.proposalId,
      requiredSigners: params.quorum,
    });

    console.log(`[MULTISIGN] Treasury spend created: ${txId} — ${dropsToXrp(params.amountDrops)} XRP to ${params.destination}`);
    return { txId, txJson: prepared };
  }

  /**
   * Create a stake refund multi-sign transaction.
   */
  async createStakeRefund(params: {
    destination: string;
    amountDrops: string;
    reason: string;
    quorum: number;
  }): Promise<{ txId: string; txJson: object }> {
    const prepared = await this.client.autofill({
      TransactionType: 'Payment',
      Account: config.xrpl.stakeAddress,
      Destination: params.destination,
      Amount: params.amountDrops,
      Memos: [{
        Memo: {
          MemoType: Buffer.from('sovereign/stake_refund').toString('hex').toUpperCase(),
          MemoData: Buffer.from(JSON.stringify({
            reason: params.reason,
          })).toString('hex').toUpperCase(),
        },
      }],
    } as Payment);

    (prepared as any).SigningPubKey = '';

    const txId = await this.storePendingTx({
      txType: 'stake_refund',
      txJson: prepared,
      description: `Stake refund: ${params.reason}`,
      proposalId: null,
      requiredSigners: params.quorum,
    });

    console.log(`[MULTISIGN] Stake refund created: ${txId} — ${dropsToXrp(params.amountDrops)} XRP to ${params.destination}`);
    return { txId, txJson: prepared };
  }

  /**
   * Create a signer list rotation transaction.
   * Updates the SignerList on the governance account.
   */
  async createSignerRotation(params: {
    account: string;
    signers: Array<{ address: string; weight: number }>;
    quorum: number;
    currentQuorum: number;
  }): Promise<{ txId: string; txJson: object }> {
    const signerEntries: SignerEntry[] = params.signers.map(s => ({
      SignerEntry: {
        Account: s.address,
        SignerWeight: s.weight,
      },
    }));

    const prepared = await this.client.autofill({
      TransactionType: 'SignerListSet',
      Account: params.account,
      SignerQuorum: params.quorum,
      SignerEntries: signerEntries,
    } as any);

    (prepared as any).SigningPubKey = '';

    const txId = await this.storePendingTx({
      txType: 'signer_rotation',
      txJson: prepared,
      description: `Signer rotation: ${params.signers.length} signers, quorum ${params.quorum}`,
      proposalId: null,
      requiredSigners: params.currentQuorum,
    });

    console.log(`[MULTISIGN] Signer rotation created: ${txId} — ${params.signers.length} signers`);
    return { txId, txJson: prepared };
  }

  /**
   * Add a signature to a pending multi-sign transaction.
   */
  addSignature(params: {
    txId: string;
    signerAddress: string;
    signedTxBlob: string;
    timestamp: number;
  }): { success: boolean; ready: boolean; reason?: string } {
    const db = getDb();

    const tx = db.prepare(`SELECT * FROM multisign_txs WHERE tx_id = ? AND status = 'pending'`).get(params.txId) as any;
    if (!tx) {
      return { success: false, ready: false, reason: 'Transaction not found or not pending' };
    }

    // Check not expired
    if (params.timestamp > tx.expires_at) {
      db.prepare(`UPDATE multisign_txs SET status = 'expired' WHERE tx_id = ?`).run(params.txId);
      return { success: false, ready: false, reason: 'Transaction has expired' };
    }

    // Check signer hasn't already signed
    const existing = db.prepare(`
      SELECT id FROM multisign_signatures WHERE tx_id = ? AND signer_address = ?
    `).get(params.txId, params.signerAddress);

    if (existing) {
      return { success: false, ready: false, reason: 'Signer already provided signature' };
    }

    // Store signature
    db.prepare(`
      INSERT INTO multisign_signatures (tx_id, signer_address, signed_tx_blob, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(params.txId, params.signerAddress, params.signedTxBlob, params.timestamp);

    // Update count
    db.prepare(`
      UPDATE multisign_txs SET collected_signers = collected_signers + 1 WHERE tx_id = ?
    `).run(params.txId);

    const updated = db.prepare(`SELECT collected_signers, required_signers FROM multisign_txs WHERE tx_id = ?`).get(params.txId) as any;
    const ready = updated.collected_signers >= updated.required_signers;

    if (ready) {
      db.prepare(`UPDATE multisign_txs SET status = 'ready' WHERE tx_id = ?`).run(params.txId);
      console.log(`[MULTISIGN] ${params.txId} ready for submission (${updated.collected_signers}/${updated.required_signers} signatures)`);
    } else {
      console.log(`[MULTISIGN] ${params.txId} signature added (${updated.collected_signers}/${updated.required_signers})`);
    }

    return { success: true, ready };
  }

  /**
   * Submit a multi-signed transaction once quorum is reached.
   */
  async submitTransaction(txId: string): Promise<{ success: boolean; hash?: string; reason?: string }> {
    const db = getDb();

    const tx = db.prepare(`SELECT * FROM multisign_txs WHERE tx_id = ? AND status = 'ready'`).get(txId) as any;
    if (!tx) {
      return { success: false, reason: 'Transaction not ready for submission' };
    }

    // Collect all signed blobs
    const signatures = db.prepare(`
      SELECT signed_tx_blob FROM multisign_signatures WHERE tx_id = ? ORDER BY timestamp ASC
    `).all(txId) as { signed_tx_blob: string }[];

    try {
      // Combine multi-signed transaction
      const signedBlobs = signatures.map(s => s.signed_tx_blob);
      const combined = multisign(signedBlobs);

      // Submit to XRPL
      const result = await this.client.submit(combined);

      if (result.result.engine_result === 'tesSUCCESS' || result.result.engine_result_code === 0) {
        const hash = result.result.tx_json?.hash || 'unknown';
        db.prepare(`
          UPDATE multisign_txs SET status = 'submitted', submitted_hash = ? WHERE tx_id = ?
        `).run(hash, txId);
        console.log(`[MULTISIGN] ${txId} submitted successfully: ${hash}`);
        return { success: true, hash: String(hash) };
      } else {
        db.prepare(`UPDATE multisign_txs SET status = 'failed' WHERE tx_id = ?`).run(txId);
        console.error(`[MULTISIGN] ${txId} submission failed: ${result.result.engine_result}`);
        return { success: false, reason: `XRPL rejected: ${result.result.engine_result}` };
      }
    } catch (err) {
      db.prepare(`UPDATE multisign_txs SET status = 'failed' WHERE tx_id = ?`).run(txId);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MULTISIGN] ${txId} submission error:`, message);
      return { success: false, reason: message };
    }
  }

  /**
   * Auto-submit all ready transactions
   */
  async submitAllReady(): Promise<Array<{ txId: string; success: boolean; hash?: string }>> {
    const db = getDb();
    const ready = db.prepare(`SELECT tx_id FROM multisign_txs WHERE status = 'ready'`).all() as { tx_id: string }[];
    const results: Array<{ txId: string; success: boolean; hash?: string }> = [];

    for (const tx of ready) {
      const result = await this.submitTransaction(tx.tx_id);
      results.push({ txId: tx.tx_id, success: result.success, hash: result.hash });
    }

    return results;
  }

  /**
   * Expire old pending transactions
   */
  expireOld(): number {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
      UPDATE multisign_txs SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?
    `).run(now);
    if (result.changes > 0) {
      console.log(`[MULTISIGN] Expired ${result.changes} pending transactions`);
    }
    return result.changes;
  }

  /**
   * Get pending transactions (for dashboard / signing UI)
   */
  getPending(): PendingMultiSign[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM multisign_txs WHERE status IN ('pending', 'ready') ORDER BY created_at DESC
    `).all() as PendingMultiSign[];
  }

  /**
   * Get transaction details with collected signatures
   */
  getTransactionDetails(txId: string): {
    tx: PendingMultiSign;
    signatures: CollectedSignature[];
  } | null {
    const db = getDb();
    const tx = db.prepare(`SELECT * FROM multisign_txs WHERE tx_id = ?`).get(txId) as PendingMultiSign | undefined;
    if (!tx) return null;

    const signatures = db.prepare(`
      SELECT tx_id, signer_address, signed_tx_blob, timestamp
      FROM multisign_signatures WHERE tx_id = ? ORDER BY timestamp ASC
    `).all(txId) as CollectedSignature[];

    return { tx, signatures };
  }

  // --- Private helpers ---

  private async storePendingTx(params: {
    txType: string;
    txJson: object;
    description: string;
    proposalId: string | null;
    requiredSigners: number;
  }): Promise<string> {
    const db = getDb();
    const txId = `msig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (7 * 86400); // 7 day expiry

    db.prepare(`
      INSERT INTO multisign_txs (
        tx_id, tx_type, tx_json, description, proposal_id,
        required_signers, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      txId, params.txType, JSON.stringify(params.txJson),
      params.description, params.proposalId,
      params.requiredSigners, now, expiresAt
    );

    return txId;
  }
}
