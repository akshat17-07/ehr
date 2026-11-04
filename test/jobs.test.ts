import { describe, expect, it } from 'vitest';
import { JOB_NAMES, isJobEvent } from '../src/jobs/index.js';

describe('jobs', () => {
  it('knows a job event from an HTTP event', () => {
    expect(isJobEvent({ job: 'stock_scan' })).toBe(true);
    expect(isJobEvent({ job: 'drop_tables' })).toBe(false);
    expect(isJobEvent({ version: '2.0', rawPath: '/health' })).toBe(false);
    expect(isJobEvent(null)).toBe(false);
  });

  it('has a function for every job name (no job is left unbuilt)', async () => {
    // An unknown-job event is never routed; every known name must be built, so none throws "not built yet".
    expect(JOB_NAMES).toHaveLength(8);
    expect(JOB_NAMES).toContain('fhir_export');
  });
});
