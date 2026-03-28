import { Client, Wallet } from 'xrpl';
import type {
  MPTokenIssuanceCreate,
  MPTokenAuthorize,
  MPTokenIssuanceSet,
  Clawback,
} from 'xrpl';
import { MPTokenIssuanceCreateFlags } from 'xrpl';
import { config } from '../config';
import { getDb } from '../db/database';
import { hexEncode } from '../utils/xrpl-helpers';

/**
 * MPT Seat Token Manager — manages council seats as XLS-33 Multi-Purpose Tokens.
 * One SEAT token = one council seat. Non-transferable, clawback-enabled.
 */
export class MptSeatManager {
  private client: Client;
  private wallet: Wallet | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  /** Set the issuer wallet (governance wallet) */
  setWallet(wallet: Wallet): void {
    this.wallet = wallet;
  }

  /** Get the stored MPT issuance ID, if any */
  getIssuanceId(): string | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM sovereign_state WHERE key = 'mpt_seat_issuance_id'`
    ).get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Store the MPT issuance ID */
  private storeIssuanceId(issuanceId: string): void {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO sovereign_state (key, value) VALUES ('mpt_seat_issuance_id', ?)`
    ).run(issuanceId);
  }

  /**
   * One-time setup: create the SOVEREIGN_SEAT MPT issuance.
   * - maxAmount: 20 (initial supply cap, expandable)
   * - transferable: false (no tfMPTCanTransfer)
   * - clawback: enabled (tfMPTCanClawback)
   * - metadata: JSON with name, description, version
   */
  async createSeatIssuance(): Promise<{ issuanceId: string; txHash: string }> {
    if (!this.wallet) throw new Error('Wallet not set — call setWallet() first');

    const existing = this.getIssuanceId();
    if (existing) {
      throw new Error(`Seat MPT issuance already exists: ${existing}`);
    }

    const metadata = JSON.stringify({
      name: 'Sovereign Seat',
      description: 'Council seat token for Sovereign autonomous AI governance. Non-transferable, clawback-enabled.',
      version: '1.0.0',
      symbol: 'SEAT',
    });

    const tx: MPTokenIssuanceCreate = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: this.wallet.address,
      MaximumAmount: '20',
      AssetScale: 0,
      MPTokenMetadata: hexEncode(metadata),
      Flags: {
        tfMPTCanClawback: true,
        tfMPTRequireAuth: true,
        // tfMPTCanTransfer deliberately omitted → non-transferable
      },
    };

    const prepared = await this.client.autofill(tx);
    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);

    const meta = result.result.meta as any;
    const issuanceId: string | undefined = meta?.mpt_issuance_id;
    if (!issuanceId) {
      throw new Error('MPT issuance succeeded but no issuance ID returned');
    }

    this.storeIssuanceId(issuanceId);
    console.log(`[MPT-SEATS] Created SOVEREIGN_SEAT issuance: ${issuanceId}`);

    return { issuanceId, txHash: signed.hash };
  }

  /**
   * Grant 1 SEAT token to an agent.
   * Two-step: issuer authorizes the holder, then sends 1 token.
   */
  async grantSeat(agentAddress: string): Promise<{ txHash: string }> {
    if (!this.wallet) throw new Error('Wallet not set');
    const issuanceId = this.getIssuanceId();
    if (!issuanceId) throw new Error('No MPT issuance — call createSeatIssuance() first');

    // Step 1: Authorize the holder (issuer-side)
    const authTx: MPTokenAuthorize = {
      TransactionType: 'MPTokenAuthorize',
      Account: this.wallet.address,
      MPTokenIssuanceID: issuanceId,
      Holder: agentAddress,
    };

    const authPrepared = await this.client.autofill(authTx);
    const authSigned = this.wallet.sign(authPrepared);
    await this.client.submitAndWait(authSigned.tx_blob);
    console.log(`[MPT-SEATS] Authorized holder ${agentAddress}`);

    // Step 2: Send 1 SEAT token via Payment with MPT amount
    const paymentTx: any = {
      TransactionType: 'Payment',
      Account: this.wallet.address,
      Destination: agentAddress,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: '1',
      },
    };

    const payPrepared = await this.client.autofill(paymentTx);
    const paySigned = this.wallet.sign(payPrepared);
    const payResult = await this.client.submitAndWait(paySigned.tx_blob);

    const txResult = (payResult.result as any).meta?.TransactionResult || 'unknown';
    if (txResult !== 'tesSUCCESS') {
      throw new Error(`SEAT grant failed: ${txResult}`);
    }

    console.log(`[MPT-SEATS] Granted 1 SEAT to ${agentAddress}`);
    return { txHash: paySigned.hash };
  }

  /**
   * Revoke (clawback) 1 SEAT token from an agent.
   */
  async revokeSeat(agentAddress: string): Promise<{ txHash: string }> {
    if (!this.wallet) throw new Error('Wallet not set');
    const issuanceId = this.getIssuanceId();
    if (!issuanceId) throw new Error('No MPT issuance');

    const clawbackTx: Clawback = {
      TransactionType: 'Clawback',
      Account: this.wallet.address,
      Amount: {
        mpt_issuance_id: issuanceId,
        value: '1',
      } as any,
      Holder: agentAddress,
    };

    const prepared = await this.client.autofill(clawbackTx);
    const signed = this.wallet.sign(prepared);
    const result = await this.client.submitAndWait(signed.tx_blob);

    const txResult = (result.result as any).meta?.TransactionResult || 'unknown';
    if (txResult !== 'tesSUCCESS') {
      throw new Error(`SEAT clawback failed: ${txResult}`);
    }

    console.log(`[MPT-SEATS] Revoked 1 SEAT from ${agentAddress}`);
    return { txHash: signed.hash };
  }

  /**
   * Check if an agent holds exactly 1 SEAT token.
   */
  async checkSeatHolder(agentAddress: string): Promise<boolean> {
    const issuanceId = this.getIssuanceId();
    if (!issuanceId) return false;

    try {
      const response = await this.client.request({
        command: 'account_objects',
        account: agentAddress,
        type: 'mptoken' as any,
      });

      const objects = response.result.account_objects as any[];
      const seatToken = objects.find(
        (obj: any) => obj.MPTokenIssuanceID === issuanceId
      );

      return seatToken ? seatToken.MPTAmount === '1' : false;
    } catch {
      return false;
    }
  }

  /**
   * Get total number of SEAT tokens currently held by all agents.
   */
  async getSeatCount(): Promise<number> {
    const issuanceId = this.getIssuanceId();
    if (!issuanceId || !this.wallet) return 0;

    try {
      const response = await this.client.request({
        command: 'account_objects',
        account: this.wallet.address,
        type: 'mpt_issuance' as any,
      });

      const objects = response.result.account_objects as any[];
      const issuance = objects.find(
        (obj: any) => obj.MPTokenIssuanceID === issuanceId
      );

      return issuance ? parseInt(issuance.OutstandingAmount || '0', 10) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Expand the max supply of SEAT tokens (governance-voted expansion).
   * Uses MPTokenIssuanceSet (which can update metadata) or re-creates.
   * Note: XRPL MPT MaximumAmount can only be set at creation. To truly expand,
   * we store the logical max in our database and enforce it off-chain.
   */
  async expandSupply(newMax: number): Promise<void> {
    const issuanceId = this.getIssuanceId();
    if (!issuanceId) throw new Error('No MPT issuance');

    const currentMax = this.getLogicalMaxSupply();
    if (newMax <= currentMax) {
      throw new Error(`New max (${newMax}) must exceed current max (${currentMax})`);
    }

    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO sovereign_state (key, value) VALUES ('mpt_seat_max_supply', ?)`
    ).run(String(newMax));

    console.log(`[MPT-SEATS] Supply cap expanded: ${currentMax} → ${newMax}`);
  }

  /** Get the logical max supply (on-chain max or expanded off-chain override) */
  getLogicalMaxSupply(): number {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM sovereign_state WHERE key = 'mpt_seat_max_supply'`
    ).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : config.governance.maxSeatsInitial;
  }
}
