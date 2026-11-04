import { describe, expect, it } from 'vitest';
import { JOB_NAMES, isJobEvent, runJob } from '../src/jobs/index.js';

describe('jobs', () => {
  it('knows a job event from an HTTP event', () => {
    expect(isJobEvent({ job: 'stock_scan' })).toBe(true);
    expect(isJobEvent({ job: 'drop_tables' })).toBe(false);
    expect(isJobEvent({ version: '2.0', rawPath: '/health' })).toBe(false);
    expect(isJobEvent(null)).toBe(false);
  });

  it('fails loudly for a job that is not built yet', async () => {
    for (const job of JOB_NAMES.filter((j) => j !== 'stock_scan' && j !== 'licence_check' && j !== 'audit_export' && j !== 'backup_export' && j !== 'backup_check' && j !== 'fhir_export')) {
      await expect(runJob({ job })).rejects.toThrow(`Job ${job} is not built yet`);
    }
  });
});
