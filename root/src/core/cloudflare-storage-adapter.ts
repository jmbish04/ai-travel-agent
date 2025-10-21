import type { SessionData, StorageAdapter, StoredMessage } from './storage-adapter.js';
import { buildThreadKey, sanitizeLimit, withRetry } from './migration-utils.js';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[] }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ success: boolean; results?: T[] }>>;
}

interface KVNamespace {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CloudflareBindings {
  db: D1Database;
  sessions: KVNamespace;
  cache?: KVNamespace;
  bucket?: R2Bucket;
}

interface MessageRow {
  role: StoredMessage['role'];
  content: string;
  sequence_number: number;
}

interface SlotRow {
  slot_key: string;
  slot_value: string;
}

export class CloudflareStorageAdapter implements StorageAdapter {
  private readonly ttlSec: number;

  constructor(private readonly bindings: CloudflareBindings, options?: { ttlSec?: number }) {
    this.ttlSec = options?.ttlSec ?? 3600;
  }

  async createSession(data: SessionData): Promise<string> {
    const payload = JSON.stringify(data);
    const ttl = this.ttlSec;
    await withRetry(() => this.bindings.sessions.put(this.sessionKey(data.id), payload, { expirationTtl: ttl }));

    await withRetry(() =>
      this.bindings
        .db
        .prepare(
          `INSERT OR REPLACE INTO sessions (id, thread_id, user_id, session_metadata, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          data.id,
          data.threadId,
          data.userId ?? null,
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.expiresAt ?? Math.floor(Date.now() / 1000) + ttl,
        )
        .run(),
    );

    return data.id;
  }

  async getSession(id: string): Promise<SessionData | null> {
    const fromKv = await withRetry(() => this.bindings.sessions.get(this.sessionKey(id), 'text'));
    if (fromKv) {
      return this.parseSession(fromKv);
    }

    const row = await withRetry(() =>
      this.bindings.db
        .prepare(`SELECT id, thread_id, user_id, session_metadata, expires_at, last_accessed_at, created_at FROM sessions WHERE id = ?`)
        .bind(id)
        .first<{
          id: string;
          thread_id: string;
          user_id: string | null;
          session_metadata: string | null;
          expires_at: number | null;
          last_accessed_at: number;
          created_at: number;
        }>(),
    );

    if (!row) return null;

    const session: SessionData = {
      id: row.id,
      threadId: row.thread_id,
      userId: row.user_id ?? undefined,
      metadata: row.session_metadata ? this.safeJson(row.session_metadata) : undefined,
      createdAt: row.created_at ?? Date.now(),
      lastAccessedAt: row.last_accessed_at ?? Date.now(),
      expiresAt: row.expires_at ?? undefined,
    };

    await this.writeSessionToKv(session);
    return session;
  }

  async updateSession(id: string, updates: Partial<SessionData>): Promise<void> {
    const current = (await this.getSession(id)) ?? {
      id,
      threadId: updates.threadId ?? id,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    const merged: SessionData = {
      ...current,
      ...updates,
      metadata: updates.metadata ?? current.metadata,
      lastAccessedAt: updates.lastAccessedAt ?? Date.now(),
    };

    await this.writeSessionToKv(merged);

    await withRetry(() =>
      this.bindings
        .db
        .prepare(
          `UPDATE sessions
             SET thread_id = ?, user_id = ?, session_metadata = ?, expires_at = ?, last_accessed_at = unixepoch()
           WHERE id = ?`
        )
        .bind(
          merged.threadId,
          merged.userId ?? null,
          merged.metadata ? JSON.stringify(merged.metadata) : null,
          merged.expiresAt ?? Math.floor(Date.now() / 1000) + this.ttlSec,
          id,
        )
        .run(),
    );
  }

  async appendMessage(threadId: string, message: StoredMessage, limit?: number): Promise<void> {
    const nextSequence = (await this.getLatestSequence(threadId)) + 1;
    await withRetry(() =>
      this.bindings
        .db
        .prepare(
          `INSERT INTO messages (thread_id, role, content, sequence_number)
           VALUES (?, ?, ?, ?)`
        )
        .bind(threadId, message.role, message.content, nextSequence)
        .run(),
    );

    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      await withRetry(() =>
        this.bindings
          .db
          .prepare(
            `DELETE FROM messages
             WHERE id IN (
               SELECT id FROM messages
               WHERE thread_id = ?
               ORDER BY sequence_number DESC
               LIMIT -1 OFFSET ?
             )`
          )
          .bind(threadId, limit)
          .run(),
      );
    }
  }

  async getMessages(threadId: string, limit?: number): Promise<StoredMessage[]> {
    const rows = await withRetry(() =>
      this.bindings
        .db
        .prepare(
          `SELECT role, content, sequence_number
           FROM messages
           WHERE thread_id = ?
           ORDER BY sequence_number DESC
           LIMIT ?`
        )
        .bind(threadId, sanitizeLimit(limit))
        .all<MessageRow>(),
    );
    return rows.results.reverse().map((row) => ({ role: row.role, content: row.content }));
  }

  async setSlots(threadId: string, slots: Record<string, string>, remove?: string[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [key, value] of Object.entries(slots)) {
      statements.push(
        this.bindings
          .db
          .prepare(
            `INSERT OR REPLACE INTO slots (thread_id, slot_key, slot_value, updated_at)
             VALUES (?, ?, ?, ?)`
          )
          .bind(threadId, key, value, now),
      );
    }

    if (remove && remove.length > 0) {
      const placeholders = remove.map(() => '?').join(',');
      statements.push(
        this.bindings
          .db
          .prepare(`DELETE FROM slots WHERE thread_id = ? AND slot_key IN (${placeholders})`)
          .bind(threadId, ...remove),
      );
    }

    if (statements.length > 0) {
      await withRetry(() => this.bindings.db.batch(statements));
    }
  }

  async getSlots(threadId: string): Promise<Record<string, string>> {
    const rows = await withRetry(() =>
      this.bindings.db
        .prepare(`SELECT slot_key, slot_value FROM slots WHERE thread_id = ?`)
        .bind(threadId)
        .all<SlotRow>(),
    );
    const result: Record<string, string> = {};
    for (const row of rows.results) {
      result[row.slot_key] = row.slot_value;
    }
    return result;
  }

  async setThreadJson<T>(threadId: string, key: string, value: T): Promise<void> {
    const payload = JSON.stringify(value);
    const storageKey = buildThreadKey(threadId, `kv:${key}`);
    await withRetry(() =>
      this.bindings.sessions.put(storageKey, payload, { expirationTtl: this.ttlSec }),
    );
    await this.updateThreadKeyIndex(threadId, key, true);
  }

  async getThreadJson<T>(threadId: string, key: string): Promise<T | null> {
    const data = await withRetry(() => this.bindings.sessions.get(buildThreadKey(threadId, `kv:${key}`), 'text'));
    return data ? (this.safeJson(data) as T) : null;
  }

  async cache<T>(key: string, value: T, ttl?: number): Promise<void> {
    const target = this.bindings.cache ?? this.bindings.sessions;
    await withRetry(() => target.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttl ?? this.ttlSec }));
  }

  async getCached<T>(key: string): Promise<T | null> {
    const target = this.bindings.cache ?? this.bindings.sessions;
    const cached = await withRetry(() => target.get(`cache:${key}`, 'text'));
    return cached ? (this.safeJson(cached) as T) : null;
  }

  async expireThread(threadId: string, ttlSec: number): Promise<void> {
    const session = await this.getSession(threadId);
    if (session) {
      session.expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
      await this.writeSessionToKv(session, ttlSec);
    }

    const keys = await this.getThreadKeyIndex(threadId);
    if (keys.length > 0) {
      await Promise.all(
        keys.map(async (key) => {
          const storageKey = buildThreadKey(threadId, `kv:${key}`);
          const payload = await withRetry(() => this.bindings.sessions.get(storageKey, 'text'));
          if (payload) {
            await withRetry(() =>
              this.bindings.sessions.put(storageKey, payload, { expirationTtl: ttlSec }),
            );
          }
        }),
      );
      await withRetry(() =>
        this.bindings.sessions.put(buildThreadKey(threadId, 'kv:index'), JSON.stringify(keys), {
          expirationTtl: ttlSec,
        }),
      );
    }

    await withRetry(() =>
      this.bindings
        .db
        .prepare(`UPDATE sessions SET expires_at = ?, last_accessed_at = unixepoch() WHERE thread_id = ?`)
        .bind(Math.floor(Date.now() / 1000) + ttlSec, threadId)
        .run(),
    );
  }

  async clearThread(threadId: string): Promise<void> {
    await withRetry(() => this.bindings.sessions.delete(this.sessionKey(threadId)));
    const index = await this.getThreadKeyIndex(threadId);
    if (index.length > 0) {
      await Promise.all(
        index.map((key) => withRetry(() => this.bindings.sessions.delete(buildThreadKey(threadId, `kv:${key}`)))),
      );
      await withRetry(() => this.bindings.sessions.delete(buildThreadKey(threadId, 'kv:index')));
    }

    await withRetry(() =>
      this.bindings.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).bind(threadId).run(),
    );
    await withRetry(() => this.bindings.db.prepare(`DELETE FROM slots WHERE thread_id = ?`).bind(threadId).run());
    await withRetry(() => this.bindings.db.prepare(`DELETE FROM thread_state WHERE thread_id = ?`).bind(threadId).run());
  }

  async healthCheck(): Promise<boolean> {
    try {
      await withRetry(() =>
        this.bindings.sessions.put('healthcheck', 'ok', { expirationTtl: 30 }),
      );
      await withRetry(() => this.bindings.sessions.delete('healthcheck'));
      await withRetry(() => this.bindings.db.prepare('SELECT 1').run());
      return true;
    } catch (error) {
      console.warn('Cloudflare storage health check failed', error);
      return false;
    }
  }

  private sessionKey(id: string): string {
    return `session:${id}`;
  }

  private async writeSessionToKv(data: SessionData, ttl = this.ttlSec): Promise<void> {
    await withRetry(() =>
      this.bindings.sessions.put(this.sessionKey(data.id), JSON.stringify(data), { expirationTtl: ttl }),
    );
  }

  private async updateThreadKeyIndex(threadId: string, key: string, include: boolean): Promise<void> {
    const indexKey = buildThreadKey(threadId, 'kv:index');
    const currentRaw = await withRetry(() => this.bindings.sessions.get(indexKey, 'text'));
    const current = new Set<string>(currentRaw ? (this.safeJson(currentRaw) as string[]) : []);
    if (include) {
      current.add(key);
    } else {
      current.delete(key);
    }
    await withRetry(() =>
      this.bindings.sessions.put(indexKey, JSON.stringify(Array.from(current)), { expirationTtl: this.ttlSec }),
    );
  }

  private async getThreadKeyIndex(threadId: string): Promise<string[]> {
    const indexKey = buildThreadKey(threadId, 'kv:index');
    const raw = await withRetry(() => this.bindings.sessions.get(indexKey, 'text'));
    if (!raw) return [];
    const parsed = this.safeJson(raw);
    return Array.isArray(parsed) ? (parsed.filter((value) => typeof value === 'string') as string[]) : [];
  }

  private parseSession(payload: string): SessionData | null {
    const json = this.safeJson(payload);
    if (!json || typeof json !== 'object') return null;
    const base = json as Partial<SessionData>;
    if (!base.id || !base.threadId) return null;
    return {
      id: base.id,
      threadId: base.threadId,
      userId: base.userId,
      metadata: base.metadata,
      createdAt: base.createdAt ?? Date.now(),
      lastAccessedAt: base.lastAccessedAt ?? Date.now(),
      expiresAt: base.expiresAt,
    };
  }

  private async getLatestSequence(threadId: string): Promise<number> {
    const row = await withRetry(() =>
      this.bindings
        .db
        .prepare(`SELECT MAX(sequence_number) as max_seq FROM messages WHERE thread_id = ?`)
        .bind(threadId)
        .first<{ max_seq: number | null }>(),
    );
    return row?.max_seq ?? 0;
  }

  private safeJson(payload: string): any {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}
