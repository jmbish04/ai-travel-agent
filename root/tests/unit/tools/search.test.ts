import { getSearchCitation, getSearchSource } from '../../../src/tools/search.js';

describe('Search Tools', () => {
  it('should get search citation', () => {
    const citation = getSearchCitation();
    expect(typeof citation).toBe('string');
    expect(citation.length).toBeGreaterThan(0);
  });

  it('should get search source', () => {
    const source = getSearchSource();
    expect(typeof source).toBe('string');
    expect(source.length).toBeGreaterThan(0);
  });
});
