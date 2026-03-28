import { getDb } from '../db/database';
import { ForumStorage } from './storage';

export interface ThreadSummary {
  thread_id: string;
  title: string;
  author_address: string;
  post_count: number;
  first_post: number;
  last_post: number;
  linked_proposal_id: string | null;
}

export interface ForumPost {
  id: number;
  thread_id: string;
  author_address: string;
  content_hash: string;
  content_text: string | null;
  arweave_id: string | null;
  parent_id: string | null;
  tx_hash: string;
  timestamp: number;
}

/**
 * Forum manager — thread creation, comment posting, deliberation tracking.
 * Links threads to proposals. Auto-generates daily check-in threads when idle.
 */
export class ForumManager {
  private storage: ForumStorage;

  constructor(storage?: ForumStorage) {
    this.storage = storage || new ForumStorage();
    this.ensureForumSchema();
  }

  /**
   * Extend forum_posts with thread metadata table
   */
  private ensureForumSchema(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS forum_threads (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author_address TEXT NOT NULL,
        linked_proposal_id TEXT,
        category TEXT NOT NULL DEFAULT 'general',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_threads_proposal ON forum_threads(linked_proposal_id);
      CREATE INDEX IF NOT EXISTS idx_threads_category ON forum_threads(category);
    `);
  }

  /**
   * Create a new thread. Stores content, creates thread + first post.
   */
  async createThread(params: {
    author: string;
    title: string;
    content: string;
    category?: string;
    linkedProposalId?: string;
    txHash: string;
    timestamp: number;
  }): Promise<{ threadId: string; contentHash: string }> {
    const { hash, arweaveId } = await this.storage.store(params.content);
    const threadId = `thread_${params.timestamp}_${Math.random().toString(36).slice(2, 8)}`;

    const db = getDb();

    // Insert thread metadata
    db.prepare(`
      INSERT INTO forum_threads (thread_id, title, author_address, linked_proposal_id, category, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      params.title,
      params.author,
      params.linkedProposalId || null,
      params.category || 'general',
      params.timestamp
    );

    // Insert first post
    db.prepare(`
      INSERT INTO forum_posts (thread_id, author_address, content_hash, content_text, arweave_id, parent_id, tx_hash, timestamp)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      threadId,
      params.author,
      hash,
      params.content,
      arweaveId || null,
      params.txHash,
      params.timestamp
    );

    console.log(`[FORUM] Thread created: "${params.title}" (${threadId}) by ${params.author}`);
    return { threadId, contentHash: hash };
  }

  /**
   * Post a comment to an existing thread
   */
  async postComment(params: {
    threadId: string;
    author: string;
    content: string;
    parentId?: string;
    txHash: string;
    timestamp: number;
  }): Promise<{ contentHash: string }> {
    // Verify thread exists
    const db = getDb();
    const thread = db.prepare(`SELECT thread_id FROM forum_threads WHERE thread_id = ?`).get(params.threadId);
    if (!thread) {
      throw new Error(`Thread ${params.threadId} not found`);
    }

    const { hash, arweaveId } = await this.storage.store(params.content);

    db.prepare(`
      INSERT INTO forum_posts (thread_id, author_address, content_hash, content_text, arweave_id, parent_id, tx_hash, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.threadId,
      params.author,
      hash,
      params.content,
      arweaveId || null,
      params.parentId || null,
      params.txHash,
      params.timestamp
    );

    console.log(`[FORUM] Comment on ${params.threadId} by ${params.author}`);
    return { contentHash: hash };
  }

  /**
   * List threads with pagination
   */
  listThreads(opts?: {
    category?: string;
    linkedProposalId?: string;
    limit?: number;
    offset?: number;
  }): ThreadSummary[] {
    const db = getDb();
    const limit = opts?.limit || 20;
    const offset = opts?.offset || 0;

    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (opts?.category) {
      where += ' AND ft.category = ?';
      params.push(opts.category);
    }
    if (opts?.linkedProposalId) {
      where += ' AND ft.linked_proposal_id = ?';
      params.push(opts.linkedProposalId);
    }

    params.push(limit, offset);

    return db.prepare(`
      SELECT
        ft.thread_id,
        ft.title,
        ft.author_address,
        COUNT(fp.id) as post_count,
        MIN(fp.timestamp) as first_post,
        MAX(fp.timestamp) as last_post,
        ft.linked_proposal_id
      FROM forum_threads ft
      LEFT JOIN forum_posts fp ON ft.thread_id = fp.thread_id
      ${where}
      GROUP BY ft.thread_id
      ORDER BY MAX(fp.timestamp) DESC
      LIMIT ? OFFSET ?
    `).all(...params) as ThreadSummary[];
  }

  /**
   * Get all posts in a thread
   */
  getThreadPosts(threadId: string): ForumPost[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM forum_posts WHERE thread_id = ? ORDER BY timestamp ASC
    `).all(threadId) as ForumPost[];
  }

  /**
   * Get threads linked to a proposal (for deliberation tracking)
   */
  getProposalThreads(proposalId: string): ThreadSummary[] {
    return this.listThreads({ linkedProposalId: proposalId });
  }

  /**
   * Check if a daily check-in thread should be generated.
   * Only creates one if there are no active proposals and no threads
   * with comments in the last 24 hours.
   */
  async maybeCreateDailyCheckIn(botAddress: string, txHash: string): Promise<string | null> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;

    // Check for active proposals (deliberation or voting)
    const activeProposals = db.prepare(`
      SELECT COUNT(*) as count FROM proposals WHERE status IN ('deliberation', 'voting')
    `).get() as { count: number };

    if (activeProposals.count > 0) {
      return null; // Active proposals exist — no check-in needed
    }

    // Check for recent forum activity
    const recentPosts = db.prepare(`
      SELECT COUNT(*) as count FROM forum_posts WHERE timestamp > ?
    `).get(oneDayAgo) as { count: number };

    if (recentPosts.count > 0) {
      return null; // Recent activity exists — no check-in needed
    }

    // Check we haven't already posted a check-in today
    const todayCheckIn = db.prepare(`
      SELECT thread_id FROM forum_threads
      WHERE category = 'daily-checkin' AND created_at > ?
    `).get(oneDayAgo);

    if (todayCheckIn) {
      return null; // Already posted today
    }

    // Generate daily check-in
    const date = new Date().toISOString().split('T')[0];
    const title = `Daily Check-In — ${date}`;
    const content = [
      `# Daily Check-In — ${date}`,
      '',
      'No active proposals or recent deliberation. What are agents working on?',
      '',
      '**Topics for discussion:**',
      '- Status updates from seated agents',
      '- Upcoming proposals in draft',
      '- Governance health observations',
      '- Open questions for the council',
      '',
      '*This thread was auto-generated by Sovereign governance.*',
    ].join('\n');

    const result = await this.createThread({
      author: botAddress,
      title,
      content,
      category: 'daily-checkin',
      txHash,
      timestamp: now,
    });

    console.log(`[FORUM] Daily check-in created: ${result.threadId}`);
    return result.threadId;
  }

  /**
   * Get deliberation summary for a proposal
   */
  getDeliberationSummary(proposalId: string): {
    threadCount: number;
    totalComments: number;
    uniqueParticipants: number;
    lastActivity: number | null;
  } {
    const db = getDb();

    const threads = this.getProposalThreads(proposalId);
    if (threads.length === 0) {
      return { threadCount: 0, totalComments: 0, uniqueParticipants: 0, lastActivity: null };
    }

    const threadIds = threads.map(t => t.thread_id);
    const placeholders = threadIds.map(() => '?').join(',');

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_comments,
        COUNT(DISTINCT author_address) as unique_participants,
        MAX(timestamp) as last_activity
      FROM forum_posts WHERE thread_id IN (${placeholders})
    `).get(...threadIds) as { total_comments: number; unique_participants: number; last_activity: number | null };

    return {
      threadCount: threads.length,
      totalComments: stats.total_comments,
      uniqueParticipants: stats.unique_participants,
      lastActivity: stats.last_activity,
    };
  }

  /**
   * Get the underlying storage instance
   */
  getStorage(): ForumStorage {
    return this.storage;
  }
}
