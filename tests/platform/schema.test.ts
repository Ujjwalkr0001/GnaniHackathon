import { describe, it, expect } from 'vitest';
import { campaignSchema, defaultCampaign } from '../../packages/shared/src/index.js';
describe('campaign contract', () => {
  it('safe defaults for either workflow', () => {
    for (const type of ['sales', 'hr'] as const) {
      const c = defaultCampaign(type);
      expect(c.compliance.test_mode).toBe(true);
      expect(c.compliance.attested).toBe(false);
      expect(c.recording).toBe(false);
    }
  });
  it('accepts overnight calling windows and rejects recording without consent implementation', () => {
    const c = defaultCampaign();
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, start: '21:00', end: '05:00' } }).success,
    ).toBe(true);
    expect(campaignSchema.safeParse({ ...c, recording: true }).success).toBe(false);
  });
});
