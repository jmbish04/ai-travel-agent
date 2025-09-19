#!/usr/bin/env tsx

import { startServer } from '../api/server.js';

console.log('🚀 Starting Voyant Travel Assistant development server...');
console.log('📊 Metrics dashboard: http://localhost:3000/metrics-dashboard.html');
console.log('📈 Metrics API: http://localhost:3000/metrics');

startServer();
