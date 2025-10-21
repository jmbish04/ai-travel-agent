-- Migration 001: Initial database schema
-- Run with: wrangler d1 execute <database-name> --file=./migrations/001_initial_schema.sql
-- Drop existing tables if they exist (development only)
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS messages;
-- DROP TABLE IF EXISTS slots;
-- DROP TABLE IF EXISTS thread_state;
-- DROP TABLE IF EXISTS verifications;
-- DROP TABLE IF EXISTS travel_bookings;
-- DROP TABLE IF EXISTS scraped_data;
-- DROP TABLE IF EXISTS user_profiles;
-- DROP TABLE IF EXISTS embeddings_metadata;
-- DROP TABLE IF EXISTS queue_logs;
-- DROP TABLE IF EXISTS metrics;
-- Sessions table to replace Redis session storage
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_id TEXT,
    session_metadata TEXT,
    -- JSON string
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER
);
CREATE INDEX idx_sessions_thread_id ON sessions (thread_id);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
-- Messages table to store conversation history
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sequence_number INTEGER NOT NULL
);
CREATE INDEX idx_messages_thread_id ON messages (thread_id);
CREATE INDEX idx_messages_thread_sequence ON messages (thread_id, sequence_number);
CREATE UNIQUE INDEX idx_messages_unique_sequence ON messages (thread_id, sequence_number);
-- Slots table to store extracted travel parameters
CREATE TABLE slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    slot_key TEXT NOT NULL,
    slot_value TEXT NOT NULL,
    category TEXT,
    -- weather, destinations, packing, attractions, etc.
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_slots_thread_id ON slots (thread_id);
CREATE INDEX idx_slots_key ON slots (slot_key);
CREATE INDEX idx_slots_category ON slots (category);
CREATE UNIQUE INDEX idx_slots_unique_key ON slots (thread_id, slot_key);
-- Thread state table to store workflow and intent state
CREATE TABLE thread_state (
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
CREATE TABLE verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'warn', 'fail')),
    notes TEXT,
    -- JSON array of notes
    scores TEXT,
    -- JSON object with relevance, grounding, coherence, context_consistency
    revised_answer TEXT,
    reply TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_verifications_thread_id ON verifications (thread_id);
CREATE INDEX idx_verifications_verdict ON verifications (verdict);
CREATE INDEX idx_verifications_created_at ON verifications (created_at);
-- Travel bookings and itineraries
CREATE TABLE travel_bookings (
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
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_bookings_user_id ON travel_bookings (user_id);
CREATE INDEX idx_bookings_thread_id ON travel_bookings (thread_id);
CREATE INDEX idx_bookings_type ON travel_bookings (booking_type);
CREATE INDEX idx_bookings_status ON travel_bookings (status);
-- Scraped data metadata (actual data stored in R2)
CREATE TABLE scraped_data (
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
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_scraped_url ON scraped_data (url);
CREATE INDEX idx_scraped_type ON scraped_data (scrape_type);
CREATE INDEX idx_scraped_user_id ON scraped_data (user_id);
CREATE INDEX idx_scraped_session_id ON scraped_data (session_id);
CREATE INDEX idx_scraped_created_at ON scraped_data (created_at);
-- User preferences and profiles
CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY,
    profile_data TEXT NOT NULL,
    -- JSON object with preferences
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Embedding vectors metadata (actual vectors stored in Vectorize)
CREATE TABLE embeddings_metadata (
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
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_embeddings_content_type ON embeddings_metadata (content_type);
CREATE INDEX idx_embeddings_source_id ON embeddings_metadata (source_id);
CREATE INDEX idx_embeddings_location ON embeddings_metadata (location);
CREATE INDEX idx_embeddings_vectorize_id ON embeddings_metadata (vectorize_id);
-- Queue processing logs
CREATE TABLE queue_logs (
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
    processed_at INTEGER
);
CREATE INDEX idx_queue_logs_queue_name ON queue_logs (queue_name);
CREATE INDEX idx_queue_logs_status ON queue_logs (status);
CREATE INDEX idx_queue_logs_created_at ON queue_logs (created_at);
-- Performance metrics
CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    labels TEXT,
    -- JSON object
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_metrics_name ON metrics (metric_name);
CREATE INDEX idx_metrics_created_at ON metrics (created_at);