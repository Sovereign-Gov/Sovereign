import { Client, Wallet, Payment } from 'xrpl';

/**
 * Shared XRPL utility functions for Sovereign governance.
 */

/**
 * Convert drops to XRP (1 XRP = 1,000,000 drops)
 */
export function dropsToXrp(drops: string): string {
  const num = BigInt(drops);
  const whole = num / 1000000n;
  const frac = num % 1000000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Convert XRP to drops
 */
export function xrpToDrops(xrp: string): string {
  const parts = xrp.split('.');
  const whole = BigInt(parts[0]) * 1000000n;
  if (parts.length === 1) return whole.toString();
  const fracStr = (parts[1] + '000000').slice(0, 6);
  const frac = BigInt(fracStr);
  return (whole + frac).toString();
}

/**
 * Truncate an XRPL address for display: first 6 + last 4 chars
 */
export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 13) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Hex-encode a UTF-8 string (for XRPL memo fields)
 */
export function hexEncode(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

/**
 * Hex-decode to a UTF-8 string (for XRPL memo fields)
 */
export function hexDecode(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf-8');
}

/**
 * Build and submit a memo-based governance transaction.
 */
export async function createMemoTransaction(
  client: Client,
  wallet: Wallet,
  destination: string,
  memoType: string,
  memoData: string,
  amount?: string
): Promise<{ hash: string; result: string }> {
  const tx: any = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    Amount: amount || '1', // minimum 1 drop if no amount specified
    Memos: [
      {
        Memo: {
          MemoType: hexEncode(memoType),
          MemoData: hexEncode(memoData),
        },
      },
    ],
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  return {
    hash: signed.hash,
    result: (result.result as any).meta?.TransactionResult || 'unknown',
  };
}
