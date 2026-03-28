import { Client, TransactionStream } from 'xrpl';
import { config } from '../config';
import { getDb } from '../db/database';
import { EventEmitter } from 'events';

export class XrplWatcher extends EventEmitter {
  private client: Client;
  private running = false;

  constructor() {
    super();
    this.client = new Client(config.xrpl.wss);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.client.connect();
    console.log(`[XRPL] Connected to ${config.xrpl.wss}`);

    // Subscribe to governance account transactions
    const accounts = [
      config.xrpl.governanceAddress,
      config.xrpl.treasuryAddress,
      config.xrpl.stakeAddress,
      config.xrpl.businessAddress,
    ].filter(Boolean);

    if (accounts.length > 0) {
      await this.client.request({
        command: 'subscribe',
        accounts,
      });
      console.log(`[XRPL] Subscribed to ${accounts.length} accounts`);
    }

    this.client.on('transaction', (tx: TransactionStream) => {
      this.handleTransaction(tx);
    });

    // Start periodic checks
    this.startPeriodicChecks();
  }

  private handleTransaction(tx: TransactionStream): void {
    const txData = tx.transaction as any;
    if (!txData || !txData.Memos) return;

    for (const memoWrapper of txData.Memos) {
      const memo = memoWrapper.Memo;
      if (!memo?.MemoType || !memo?.MemoData) continue;

      const memoType = Buffer.from(memo.MemoType, 'hex').toString('utf-8');
      const memoData = Buffer.from(memo.MemoData, 'hex').toString('utf-8');

      try {
        this.routeTransaction(memoType, memoData, txData);
      } catch (err) {
        console.error(`[XRPL] Error routing transaction:`, err);
      }
    }
  }

  private routeTransaction(memoType: string, memoData: string, tx: any): void {
    switch (memoType) {
      case 'sovereign/heartbeat':
        this.emit('heartbeat', {
          agent: tx.Account,
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/vote':
        this.emit('vote', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/proposal':
        this.emit('proposal', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/forum':
        this.emit('forum_post', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/seat_claim':
        this.emit('seat_claim', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/vouch':
        this.emit('vouch', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      case 'sovereign/challenge':
        this.emit('challenge', {
          agent: tx.Account,
          data: JSON.parse(memoData),
          txHash: tx.hash,
          timestamp: this.rippleTimeToUnix(tx.date),
        });
        break;

      default:
        // Unknown memo type — ignore
        break;
    }
  }

  private startPeriodicChecks(): void {
    // Check for lapsed heartbeats every 5 minutes
    setInterval(() => {
      this.emit('check_heartbeats');
    }, 5 * 60 * 1000);

    // Check for lapsed activity every 15 minutes
    setInterval(() => {
      this.emit('check_activity');
    }, 15 * 60 * 1000);

    // Check proposal deadlines every minute
    setInterval(() => {
      this.emit('check_deadlines');
    }, 60 * 1000);
  }

  private rippleTimeToUnix(rippleTime: number): number {
    // Ripple epoch starts at 2000-01-01T00:00:00Z
    return rippleTime + 946684800;
  }

  async getAccountBalance(address: string): Promise<string> {
    const response = await this.client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated',
    });
    return response.result.account_data.Balance;
  }

  async getAccountTransactions(address: string, limit = 20): Promise<any[]> {
    const response = await this.client.request({
      command: 'account_tx',
      account: address,
      limit,
    });
    return response.result.transactions;
  }

  getClient(): Client {
    return this.client;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.client.disconnect();
    console.log('[XRPL] Disconnected');
  }
}
