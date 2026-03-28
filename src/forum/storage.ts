import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

interface StoredContent {
  hash: string;
  content: string;
  arweaveId?: string;
  timestamp: number;
}

/**
 * Forum content storage — SHA-256 hashing, local cache, Arweave upload.
 * Content is addressed by hash. Store locally first, push to Arweave async.
 */
export class ForumStorage {
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || path.join(path.dirname(config.db.path), 'forum-cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Hash content with SHA-256
   */
  hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Store content locally and optionally push to Arweave.
   * Returns the content hash.
   */
  async store(content: string): Promise<{ hash: string; arweaveId?: string }> {
    const hash = this.hashContent(content);
    const entry: StoredContent = {
      hash,
      content,
      timestamp: Date.now(),
    };

    // Write to local cache
    const filePath = this.cachePath(hash);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      console.log(`[STORAGE] Cached content ${hash.slice(0, 12)}...`);
    }

    // Attempt Arweave upload (non-blocking failure)
    let arweaveId: string | undefined;
    try {
      arweaveId = await this.uploadToArweave(content, hash);
      if (arweaveId) {
        entry.arweaveId = arweaveId;
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
        console.log(`[STORAGE] Arweave upload: ${arweaveId} for ${hash.slice(0, 12)}...`);
      }
    } catch (err) {
      console.warn(`[STORAGE] Arweave upload failed for ${hash.slice(0, 12)}...:`, err);
    }

    return { hash, arweaveId };
  }

  /**
   * Retrieve content by hash. Checks local cache first, then Arweave.
   */
  async retrieve(hash: string): Promise<string | null> {
    // Check local cache
    const filePath = this.cachePath(hash);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const entry: StoredContent = JSON.parse(raw);
      return entry.content;
    }

    // Try Arweave gateway
    try {
      const content = await this.fetchFromArweave(hash);
      if (content) {
        // Re-verify hash
        const verified = this.hashContent(content);
        if (verified !== hash) {
          console.error(`[STORAGE] Hash mismatch from Arweave for ${hash.slice(0, 12)}...`);
          return null;
        }
        // Cache locally
        const entry: StoredContent = { hash, content, timestamp: Date.now() };
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
        return content;
      }
    } catch (err) {
      console.warn(`[STORAGE] Arweave fetch failed for ${hash.slice(0, 12)}...:`, err);
    }

    return null;
  }

  /**
   * Check if content exists locally
   */
  hasLocal(hash: string): boolean {
    return fs.existsSync(this.cachePath(hash));
  }

  /**
   * Get Arweave ID for a hash (if uploaded)
   */
  getArweaveId(hash: string): string | undefined {
    const filePath = this.cachePath(hash);
    if (!fs.existsSync(filePath)) return undefined;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: StoredContent = JSON.parse(raw);
    return entry.arweaveId;
  }

  /**
   * Retry Arweave upload for content that failed previously
   */
  async retryPendingUploads(): Promise<number> {
    let uploaded = 0;
    const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const raw = fs.readFileSync(path.join(this.cacheDir, file), 'utf-8');
      const entry: StoredContent = JSON.parse(raw);
      if (entry.arweaveId) continue; // Already uploaded

      try {
        const arweaveId = await this.uploadToArweave(entry.content, entry.hash);
        if (arweaveId) {
          entry.arweaveId = arweaveId;
          fs.writeFileSync(path.join(this.cacheDir, file), JSON.stringify(entry, null, 2), 'utf-8');
          uploaded++;
        }
      } catch {
        // Skip failures silently during retry
      }
    }

    if (uploaded > 0) {
      console.log(`[STORAGE] Retried Arweave uploads: ${uploaded} succeeded`);
    }
    return uploaded;
  }

  /**
   * Upload content to Arweave. Returns transaction ID or undefined.
   * Uses Arweave HTTP API with wallet key.
   */
  private async uploadToArweave(content: string, _hash: string): Promise<string | undefined> {
    const walletPath = config.arweave.walletPath;
    if (!walletPath || !fs.existsSync(walletPath)) {
      // No wallet configured — skip Arweave
      return undefined;
    }

    const gateway = config.arweave.gateway;

    // Dynamic require for arweave (optional dependency)
    let Arweave: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Arweave = require('arweave');
      if (Arweave.default) Arweave = Arweave.default;
    } catch {
      console.warn('[STORAGE] arweave package not installed — skipping upload');
      return undefined;
    }

    const arweave = Arweave.init({
      host: new URL(gateway).hostname,
      port: new URL(gateway).port || 443,
      protocol: new URL(gateway).protocol.replace(':', ''),
    });

    const walletKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const tx = await arweave.createTransaction({ data: content }, walletKey);
    tx.addTag('Content-Type', 'text/plain');
    tx.addTag('App-Name', 'Sovereign-Gov');
    tx.addTag('Content-Hash', _hash);

    await arweave.transactions.sign(tx, walletKey);
    const response = await arweave.transactions.post(tx);

    if (response.status === 200 || response.status === 202) {
      return tx.id as string;
    }

    console.warn(`[STORAGE] Arweave post returned status ${response.status}`);
    return undefined;
  }

  /**
   * Fetch content from Arweave by looking up the content hash tag.
   * Falls back to GraphQL search on the gateway.
   */
  private async fetchFromArweave(_hash: string): Promise<string | null> {
    const gateway = config.arweave.gateway;

    // GraphQL query to find TX by Content-Hash tag
    const query = {
      query: `{
        transactions(tags: [
          { name: "App-Name", values: ["Sovereign-Gov"] },
          { name: "Content-Hash", values: ["${_hash}"] }
        ], first: 1) {
          edges { node { id } }
        }
      }`,
    };

    try {
      const res = await fetch(`${gateway}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      });

      if (!res.ok) return null;
      const data = await res.json() as any;
      const edges = data?.data?.transactions?.edges;
      if (!edges || edges.length === 0) return null;

      const txId = edges[0].node.id;
      const contentRes = await fetch(`${gateway}/${txId}`);
      if (!contentRes.ok) return null;

      return await contentRes.text();
    } catch {
      return null;
    }
  }

  private cachePath(hash: string): string {
    return path.join(this.cacheDir, `${hash}.json`);
  }
}
