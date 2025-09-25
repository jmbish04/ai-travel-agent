/**
 * Session management for preventing cross-session data contamination
 */

import { randomUUID } from 'crypto';

interface SessionMetadata {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  processId: string;
}

export type { SessionMetadata };

const CURRENT_PROCESS_ID = randomUUID();
const SESSION_SCOPE = (process.env.SESSION_SCOPE || 'global').toLowerCase();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Generate a new session ID
 */
export function generateSessionId(): string {
  return `session_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Create session metadata
 */
export function createSessionMetadata(sessionId: string): SessionMetadata {
  const now = Date.now();
  return {
    id: sessionId,
    createdAt: now,
    lastAccessedAt: now,
    processId: SESSION_SCOPE === 'process' ? CURRENT_PROCESS_ID : 'global'
  };
}

/**
 * Check if session is valid and belongs to current process
 */
export function isSessionValid(metadata: SessionMetadata | null): boolean {
  if (!metadata) return false;
  
  const now = Date.now();
  
  // Respect session scope: in 'global' mode, ignore processId differences
  if (SESSION_SCOPE === 'process') {
    if (metadata.processId !== CURRENT_PROCESS_ID) {
      return false;
    }
  }
  
  // Check if session has timed out
  if (now - metadata.lastAccessedAt > SESSION_TIMEOUT_MS) {
    return false;
  }
  
  return true;
}

/**
 * Update session access time
 */
export function updateSessionAccess(metadata: SessionMetadata): SessionMetadata {
  return {
    ...metadata,
    lastAccessedAt: Date.now()
  };
}

/**
 * Clean up expired sessions
 */
export function isSessionExpired(metadata: SessionMetadata): boolean {
  const now = Date.now();
  return now - metadata.lastAccessedAt > SESSION_TIMEOUT_MS;
}
