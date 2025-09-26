// Central test env loader for all suites
process.env.TZ = process.env.TZ || 'UTC';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

// Keep tests offline by default; golden tests will opt-in
process.env.AUTO_VERIFY_REPLIES = process.env.AUTO_VERIFY_REPLIES || 'false';

// Reduce any external timeouts to keep tests snappy
process.env.LLM_MAX_TOKENS = process.env.LLM_MAX_TOKENS || '256';
process.env.LLM_TEMPERATURE = process.env.LLM_TEMPERATURE || '0.2';

// Ensure in-memory session store for tests
process.env.SESSION_STORE = 'memory';

export {};

