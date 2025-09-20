# Testing Guidelines

## Test Structure

- **Unit Tests** (`tests/unit/`): Test individual modules and functions
- **Integration Tests** (`tests/integration/`): Test component interactions
- **E2E Tests** (`tests/e2e/`): Test complete user flows

## Key Principles

### Deterministic First
- Always add deterministic assertions before LLM evaluations
- Assert on structure, types, and expected patterns
- Use `assertWithLLMOrSkip()` for quality checks that require LLM evaluation

### Fixture-Based Mocking
- Use `mockExternalApis()` helper for consistent API mocking
- Store fixtures in `tests/fixtures/` organized by service
- Prefer fixtures over inline mock data for reusability

### State Management
- Tests automatically reset slot memory and session store between runs
- Use `resetTestState()` helper if manual reset needed
- Avoid cross-test dependencies

## Helpers

### API Mocking
```typescript
import { mockExternalApis } from '../helpers.js';

// Mock weather API with Berlin fixture
await mockExternalApis({ weatherFixture: 'berlin' });

// Mock multiple APIs
await mockExternalApis({ 
  weatherFixture: 'berlin',
  countryFixture: 'france',
  searchFixture: 'hotels_paris'
});
```

### LLM Evaluation
```typescript
import { assertWithLLMOrSkip } from '../helpers.js';

// Gracefully skip when no LLM evaluator configured
await assertWithLLMOrSkip(
  async () => {
    const { expectLLMEvaluation } = await import('../../src/test/llm-evaluator.js');
    return expectLLMEvaluation(
      'Test description',
      response.reply,
      'Expected behavior'
    ).toPass();
  },
  'Test name for logging'
);
```

### Chat Testing
```typescript
import { chat } from '../helpers.js';

const response = await chat(app, 'test message', threadId);
expect(response.reply).toBeTruthy();
expect(response.threadId).toBeTruthy();
```

## Running Tests

```bash
# All tests
npm run test

# Specific suite
npm run test -- tests/unit/
npm run test -- tests/integration/
npm run test -- tests/e2e/

# With LLM evaluation (requires API keys)
OPENROUTER_API_KEY=xxx npm run test

# With transcript recording
npm run test -- --save-transcripts
```

## Coverage Goals

- Unit tests: Assert outcomes, slots, confidence scores
- Integration tests: Test consent flows, clarification, IRROPS, policy browser
- E2E tests: Test complete user journeys with mocked external APIs
- Target ≥80% branch coverage on agent routing and tools
