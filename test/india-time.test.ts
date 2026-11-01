import { describe, expect, it } from 'vitest';
import { indiaDate } from '../src/time/india.js';

describe('indiaDate', () => {
  it('gives the date in India, which starts 5h30 before UTC', () => {
    expect(indiaDate(new Date('2026-03-31T18:29:59Z'))).toBe('2026-03-31');
    expect(indiaDate(new Date('2026-03-31T18:30:00Z'))).toBe('2026-04-01');
  });
});
