export interface SessionData {
  id: string;
  threadId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt?: number;
}

export type StoredMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export interface StorageAdapter {
  /**
   * Creates a persisted session and returns its identifier.
   */
  createSession(data: SessionData): Promise<string>;

  /**
   * Retrieves a session by identifier.
   */
  getSession(id: string): Promise<SessionData | null>;

  /**
   * Applies a partial update to a session record.
   */
  updateSession(id: string, updates: Partial<SessionData>): Promise<void>;

  /**
   * Persists a conversation message for the supplied thread identifier.
   */
  appendMessage(threadId: string, message: StoredMessage, limit?: number): Promise<void>;

  /**
   * Retrieves messages for a thread ordered chronologically.
   */
  getMessages(threadId: string, limit?: number): Promise<StoredMessage[]>;

  /**
   * Overwrites slots for a thread and optionally removes slot keys.
   */
  setSlots(
    threadId: string,
    slots: Record<string, string>,
    remove?: string[] | undefined,
  ): Promise<void>;

  /**
   * Reads all slots for a thread.
   */
  getSlots(threadId: string): Promise<Record<string, string>>;

  /**
   * Stores arbitrary JSON payloads scoped to a thread and key.
   */
  setThreadJson<T>(threadId: string, key: string, value: T): Promise<void>;

  /**
   * Retrieves JSON payloads stored for a thread and key.
   */
  getThreadJson<T>(threadId: string, key: string): Promise<T | null>;

  /**
   * Sets a cache entry with optional ttl in seconds.
   */
  cache<T>(key: string, value: T, ttl?: number): Promise<void>;

  /**
   * Retrieves a cached entry or null when missing.
   */
  getCached<T>(key: string): Promise<T | null>;

  /**
   * Updates expiry information for all thread scoped data.
   */
  expireThread(threadId: string, ttlSec: number): Promise<void>;

  /**
   * Removes all persisted data for the supplied thread.
   */
  clearThread(threadId: string): Promise<void>;

  /**
   * Health check hook used by diagnostics.
   */
  healthCheck?(): Promise<boolean>;
}
