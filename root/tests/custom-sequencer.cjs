const Sequencer = require('@jest/test-sequencer').default;

class CustomSequencer extends Sequencer {
  sort(tests) {
    // Keep provided order; no reordering
    return tests;
  }
}

module.exports = CustomSequencer;

