#!/usr/bin/env node

import { spawn } from 'child_process';

let metricsServer = null;
let testProcess = null;
let isShuttingDown = false;

function log(message, ...args) {
  console.log(`[${new Date().toISOString()}]`, message, ...args);
}

// Start metrics server
function startMetricsServer() {
  log('Starting metrics server...');
  metricsServer = spawn('tsx', ['src/util/metrics-server.ts'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.cwd()
  });

  metricsServer.on('error', (err) => {
    log('Metrics server error:', err);
  });

  metricsServer.on('exit', (code) => {
    if (!isShuttingDown) {
      log(`Metrics server exited with code ${code}, restarting...`);
      setTimeout(startMetricsServer, 2000);
    }
  });

  // Give server time to start
  return new Promise(resolve => setTimeout(resolve, 3000));
}

// Run single test iteration
function runTest() {
  return new Promise((resolve) => {
    log('Running test iteration...');
    
    testProcess = spawn('npx', ['jest', '--config', 'jest.config.cjs', 'tests/e2e/endless_scenarios.test.ts', '--verbose'], {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' }
    });

    testProcess.on('exit', (code) => {
      log(`Test completed with code ${code}`);
      resolve(code);
    });

    testProcess.on('error', (err) => {
      log('Test error:', err);
      resolve(1);
    });
  });
}

// Main endless loop
async function runEndlessTests() {
  await startMetricsServer();
  
  log('🚀 Starting endless test loop...');
  log('📊 Metrics dashboard: http://localhost:3001/');
  log('⏹️  Press Ctrl+C to stop');

  let iteration = 1;
  
  while (!isShuttingDown) {
    log(`\n=== Test Iteration ${iteration} ===`);
    
    const exitCode = await runTest();
    
    if (exitCode === 0) {
      log(`✅ Iteration ${iteration} passed`);
    } else {
      log(`❌ Iteration ${iteration} failed (code: ${exitCode})`);
    }
    
    iteration++;
    
    // Wait 5 seconds between iterations
    if (!isShuttingDown) {
      log('Waiting 5 seconds before next iteration...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Graceful shutdown
function shutdown() {
  if (isShuttingDown) return;
  
  isShuttingDown = true;
  log('\n🛑 Shutting down...');
  
  if (testProcess) {
    testProcess.kill('SIGTERM');
  }
  
  if (metricsServer) {
    metricsServer.kill('SIGTERM');
  }
  
  setTimeout(() => {
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the endless test loop
runEndlessTests().catch((err) => {
  log('Fatal error:', err);
  process.exit(1);
});
