-- Travel Agent Backend D1 Database Schema
-- This schema migrates from Redis-based storage to D1 relational database
-- Sessions table to replace Redis session storage
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT,
    session_metadata TEXT,
    -- JSON string
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER,
    INDEX idx_thread_id (thread_id),
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at)
);
-- Messages table to store conversation history
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sequence_number INTEGER NOT NULL,
    INDEX idx_thread_id (thread_id),
    INDEX idx_thread_sequence (thread_id, sequence_number),
    UNIQUE(thread_id, sequence_number)
);
-- Slots table to store extracted travel parameters
CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    slot_key TEXT NOT NULL,
    slot_value TEXT NOT NULL,
    category TEXT,
    -- weather, destinations, packing, attractions, etc.
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_thread_id (thread_id),
    INDEX idx_slot_key (slot_key),
    INDEX idx_category (category),
    UNIQUE(thread_id, slot_key)
);
-- Thread state table to store workflow and intent state
CREATE TABLE IF NOT EXISTS thread_state (
    thread_id TEXT PRIMARY KEY,
    last_intent TEXT,
    expected_missing TEXT,
    -- JSON array of missing slot keys
    last_facts TEXT,
    -- JSON array of facts
    last_decisions TEXT,
    -- JSON array of decisions
    last_reply TEXT,
    last_user_message TEXT,
    prev_user_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Verification results table
CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warn', 'fail')),
    notes TEXT,
    -- JSON array of notes
    scores TEXT,
    -- JSON object with relevance, grounding, coherence, context_consistency
    revised_answer TEXT,
    reply TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_thread_id (thread_id),
    INDEX idx_verdict (verdict),
    INDEX idx_created_at (created_at)
);
-- Travel bookings and itineraries
CREATE TABLE IF NOT EXISTS travel_bookings (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    thread_id TEXT,
    booking_type TEXT NOT NULL CHECK (
        booking_type IN ('flight', 'hotel', 'attraction', 'package')
    ),
    booking_data TEXT NOT NULL,
    -- JSON object
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_user_id (user_id),
    INDEX idx_thread_id (thread_id),
    INDEX idx_booking_type (booking_type),
    INDEX idx_status (status)
);
-- Scraped data metadata (actual data stored in R2)
CREATE TABLE IF NOT EXISTS scraped_data (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    scrape_type TEXT NOT NULL CHECK (
        scrape_type IN ('hotel', 'attraction', 'flight', 'general')
    ),
    r2_key TEXT NOT NULL,
    -- Key in R2 bucket where actual data is stored
    metadata TEXT,
    -- JSON object with title, description, etc.
    user_id TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_url (url),
    INDEX idx_scrape_type (scrape_type),
    INDEX idx_user_id (user_id),
    INDEX idx_session_id (session_id),
    INDEX idx_created_at (created_at)
);
-- User preferences and profiles
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    profile_data TEXT NOT NULL,
    -- JSON object with preferences
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Embedding vectors metadata (actual vectors stored in Vectorize)
CREATE TABLE IF NOT EXISTS embeddings_metadata (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (
        content_type IN ('hotel', 'attraction', 'review', 'content')
    ),
    source_id TEXT,
    -- Reference to original data (booking_id, scraped_data_id, etc.)
    title TEXT,
    description TEXT,
    location TEXT,
    tags TEXT,
    -- JSON array
    vectorize_id TEXT,
    -- ID in Vectorize index
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_content_type (content_type),
    INDEX idx_source_id (source_id),
    INDEX idx_location (location),
    INDEX idx_vectorize_id (vectorize_id)
);
-- Queue processing logs
CREATE TABLE IF NOT EXISTS queue_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_name TEXT NOT NULL,
    message_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'processing', 'completed', 'failed')
    ),
    payload TEXT,
    -- JSON object
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at INTEGER,
    INDEX idx_queue_name (queue_name),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
);
-- Performance metrics
CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    labels TEXT,
    -- JSON object
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    INDEX idx_metric_name (metric_name),
    INDEX idx_created_at (created_at)
);