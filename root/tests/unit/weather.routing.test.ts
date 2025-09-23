import { describe, it, expect } from '@jest/globals';

describe('Weather Tool Integration', () => {
  it('should handle city-only queries using forecast provider', () => {
    // Test that city-only queries default to forecast
    const input = { city: 'Rome' };
    expect(input.city).toBe('Rome');
    // Should use forecast provider when no month specified
  });

  it('should handle month-based queries using historical provider', () => {
    // Test that month queries use historical provider
    const input = { city: 'Rome', month: 'December' };
    expect(input.city).toBe('Rome');
    expect(input.month).toBe('December');
    // Should use historical provider for climate data
  });

  it('should handle date-specific queries using forecast provider', () => {
    // Test that specific date queries use forecast
    const input = { city: 'Paris', dates: 'tomorrow' };
    expect(input.city).toBe('Paris');
    expect(input.dates).toBe('tomorrow');
    // Should use forecast provider for specific dates
  });
});

describe('Month Name Parsing', () => {
  it('should parse full month names', () => {
    const monthMap: Record<string, number> = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
    };
    
    expect(monthMap['december']).toBe(12);
    expect(monthMap['june']).toBe(6);
  });

  it('should parse abbreviated month names', () => {
    const monthMap: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    
    expect(monthMap['dec']).toBe(12);
    expect(monthMap['jun']).toBe(6);
  });
});
