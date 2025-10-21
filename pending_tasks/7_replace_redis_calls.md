# Task 7: Replace Redis Calls with Cloudflare Storage Clients

## Objective
Systematically replace all Redis operations in the codebase with equivalent Cloudflare storage operations using D1, KV, and R2.

## Context
The original system heavily relies on Redis for various storage needs. This task involves mapping Redis operations to appropriate Cloudflare storage services and updating all code references.

## Current Redis Usage Analysis

### From `root/src/core/stores/redis.ts`:
- Session storage and retrieval
- Message history storage
- Slot/state management
- JSON serialization/deserialization
- TTL and expiration handling

### From `root/src/core/session_store.ts`:
- SessionStore interface implementation
- Message append operations
- Slot get/set operations
- JSON data storage
- Session expiration

## Migration Mapping

### Redis → Cloudflare Storage Mapping:
- **Redis Strings/JSON** → **KV** (for cache, sessions)
- **Redis Lists** → **D1** (for message history with ordering)
- **Redis Hashes** → **D1** (for structured data with relationships)
- **Redis TTL** → **KV TTL** + **D1 expiration columns**
- **Redis Pub/Sub** → **Durable Objects** (for real-time features)

## Implementation Steps

### 1. Create Storage Abstraction Layer
Create `src/core/storage-adapter.ts` that provides a unified interface:

```typescript
interface StorageAdapter {
  // Session operations
  createSession(data: SessionData): Promise<string>;
  getSession(id: string): Promise<SessionData | null>;
  updateSession(id: string, updates: Partial<SessionData>): Promise<void>;

  // Message operations
  appendMessage(threadId: string, message: Message): Promise<void>;
  getMessages(threadId: string, limit?: number): Promise<Message[]>;

  // Slot operations
  setSlots(threadId: string, slots: Record<string, string>): Promise<void>;
  getSlots(threadId: string): Promise<Record<string, string>>;

  // Cache operations
  cache<T>(key: string, value: T, ttl?: number): Promise<void>;
  getCached<T>(key: string): Promise<T | null>;
}
```

### 2. Implement Cloudflare Storage Adapter
Create `src/core/cloudflare-storage-adapter.ts`:
- Use D1Repository for structured data
- Use KV service for caching and sessions
- Use R2 for large data storage
- Implement proper error handling and retries

### 3. Update Core Components

#### Session Store Migration:
- Replace `root/src/core/stores/redis.ts` functionality
- Update `root/src/core/session_store.ts` interface implementation
- Maintain backward compatibility during transition

#### Slot Memory Migration:
- Update `root/src/core/slot_memory.ts`
- Replace Redis calls with D1 operations
- Maintain slot state persistence

#### Memory Module Migration:
- Update `root/src/core/memory.ts`
- Replace message storage with D1
- Maintain message ordering and limits

## Files to Create/Modify

### New Files:
- `src/core/storage-adapter.ts` - Storage abstraction interface
- `src/core/cloudflare-storage-adapter.ts` - Cloudflare implementation
- `src/core/migration-utils.ts` - Helper functions for data migration

### Modified Files:
- `src/core/chat-handler.ts` - Use new storage adapter
- `src/index.ts` - Initialize storage adapter
- All files importing from session_store or memory modules

## Detailed Migration Tasks

### 1. Session Storage Migration
```typescript
// Redis (old)
await redis.set(`session:${id}`, JSON.stringify(sessionData), 'EX', ttl);

// Cloudflare (new)
await kv.set(`session:${id}`, sessionData, ttl);
await db.createSession(sessionData);
```

### 2. Message History Migration
```typescript
// Redis (old)
await redis.lpush(`messages:${threadId}`, JSON.stringify(message));
await redis.ltrim(`messages:${threadId}`, 0, limit - 1);

// Cloudflare (new)
const seqNum = await db.getLatestSequenceNumber(threadId) + 1;
await db.addMessage({ ...message, threadId, sequence_number: seqNum });
```

### 3. Slot Management Migration
```typescript
// Redis (old)
await redis.hset(`slots:${threadId}`, key, value);
const slots = await redis.hgetall(`slots:${threadId}`);

// Cloudflare (new)
await db.setSlot({ threadId, slot_key: key, slot_value: value });
const slots = await db.getSlots(threadId);
```

## Data Migration Strategy

### 1. Parallel Operation Phase
- Run both Redis and Cloudflare storage
- Write to both systems
- Read from Redis (primary) with Cloudflare fallback
- Validate data consistency

### 2. Migration Phase
- Export existing Redis data
- Import into appropriate Cloudflare services
- Validate data integrity
- Switch read operations to Cloudflare

### 3. Cleanup Phase
- Remove Redis dependencies
- Clean up old code paths
- Update documentation

## Error Handling Strategy

### Fallback Mechanisms:
- Primary: Cloudflare storage
- Fallback: In-memory cache (temporary)
- Error recovery: Retry with exponential backoff
- Data consistency: Version tracking and conflict resolution

### Monitoring:
- Track operation success/failure rates
- Monitor performance compared to Redis
- Alert on storage service unavailability
- Log data consistency issues

## Success Criteria
- [ ] All Redis operations identified and mapped
- [ ] Storage adapter abstraction implemented
- [ ] Cloudflare storage adapter fully functional
- [ ] All core components updated to use new adapter
- [ ] Data migration completed successfully
- [ ] Performance parity with Redis achieved
- [ ] Error handling and fallbacks working
- [ ] Redis dependencies completely removed

## Testing Requirements
- Unit tests for storage adapter
- Integration tests for each storage operation
- Performance benchmarks vs Redis
- Data consistency validation
- Error scenario testing
- Load testing with realistic data volumes

## Performance Considerations
- D1 query optimization for message retrieval
- KV key design for efficient operations
- Batch operations where possible
- Edge caching strategies
- Connection pooling and reuse

## Dependencies
- Completed KV namespaces (Task 6)
- Completed R2 buckets (Task 5)
- D1 repository implementation (already done)
- Existing Redis codebase analysis
