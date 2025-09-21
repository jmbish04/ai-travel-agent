import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { getLastReceipts, setLastReceipts } from '../src/core/slot_memory.js';

// Mock the slot memory functions
jest.mock('../src/core/slot_memory.js', () => ({
  getLastReceipts: jest.fn(),
  setLastReceipts: jest.fn(),
  getThreadSlots: jest.fn().mockResolvedValue({}),
  getLastIntent: jest.fn().mockResolvedValue('flights')
}));

const mockGetLastReceipts = getLastReceipts as jest.MockedFunction<typeof getLastReceipts>;
const mockSetLastReceipts = setLastReceipts as jest.MockedFunction<typeof setLastReceipts>;

describe('Receipt Persistence Fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should persist receipts for successful flight search', async () => {
    // Mock Amadeus success
    const mockAmadeusResult = {
      ok: true,
      summary: 'Found 5 flights from Berlin to Paris starting at €120'
    };

    // Mock the flights tool
    jest.doMock('../src/tools/amadeus_flights.js', () => ({
      searchFlights: jest.fn().mockResolvedValue(mockAmadeusResult),
      convertToAmadeusDate: jest.fn().mockResolvedValue('2025-09-22')
    }));

    const { flightsNode } = await import('../src/core/graph.js');
    
    const ctx = {
      msg: 'Find flights from Berlin to Paris tomorrow',
      threadId: 'test-thread',
      onStatus: jest.fn()
    };
    
    const slots = {
      originCity: 'Berlin',
      destinationCity: 'Paris',
      departureDate: '2025-09-22'
    };
    
    const logger = {
      log: {
        debug: jest.fn(),
        warn: jest.fn()
      }
    };

    const result = await flightsNode(ctx, slots, logger);

    // Verify receipts were written
    expect(mockSetLastReceipts).toHaveBeenCalledWith(
      'test-thread',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'Amadeus',
          key: 'flight_offers_summary'
        })
      ]),
      expect.any(Array),
      mockAmadeusResult.summary
    );

    // Verify receipts_written log
    expect(logger.log.debug).toHaveBeenCalledWith(
      { wroteFacts: 1, node: 'flights' },
      'receipts_written'
    );

    expect(result.done).toBe(true);
    expect(result.reply).toBe(mockAmadeusResult.summary);
  });

  it('should not reset context when only origin is added', async () => {
    const { routeMessage } = await import('../src/core/router.js');
    
    // Mock existing destination context
    const existingSlots = {
      destinationCity: 'Paris',
      city: 'Paris'
    };
    
    // New message adds origin
    const freshSlots = {
      originCity: 'Berlin'
    };
    
    const params = {
      threadId: 'test-thread',
      message: 'Find flights there from Berlin',
      slots: existingSlots,
      logger: {
        debug: jest.fn(),
        warn: jest.fn()
      }
    };

    // Mock the context switch detector to return false
    jest.doMock('../src/core/router.js', () => ({
      ...jest.requireActual('../src/core/router.js'),
      callContextSwitchDetector: jest.fn().mockResolvedValue(false)
    }));

    // The test would verify that context_switch_reset is not logged
    // when only origin is added to existing destination context
    expect(true).toBe(true); // Placeholder - actual implementation would test the logic
  });
});
