import { describe, it, expect } from 'vitest';
import { campaignSchema } from '../../packages/shared/src/index.js';
import {
  campaignDraftMinimalSchema,
  expandToFullConfig,
  newMinimalDraft,
} from '../../packages/shared/src/minimal.js';
describe('minimal campaign expansion', () => {
  it('keeps incomplete drafts without inventing company or offer facts', () => {
    const d = newMinimalDraft('sales');
    expect(d.company_name).toBe('');
    expect(d.offering).toBe('');
    expect(campaignDraftMinimalSchema.safeParse(d).success).toBe(false);
  });
  it('expands a short sales form into the unchanged server contract', () => {
    const d = {
      ...newMinimalDraft('sales'),
      company_name: 'Synthetic studio',
      offering: 'A shared project workspace.',
      price: '',
    };
    const c = expandToFullConfig(d, {
      contacts: [
        {
          phone: '+12025550101',
          first_name: 'Sample',
          candidate_name: '',
          current_role: '',
          source: '',
          sample: true,
        },
      ],
    });
    expect(campaignSchema.safeParse(c).success).toBe(true);
    expect(c.schedule.start).toBe('10:00');
    expect(c.schedule.end).toBe('19:00');
    expect(c.handoff).toBe('none');
    expect(c.compliance).toEqual({ test_mode: true, attested: false, allowlist: ['+12025550101'] });
    expect(c.recording).toBe(false);
    expect(c.price_text).toBe('');
    expect(c.voice['hi-IN']).toBe('Shivani');
  });
  it('screens only explicit job requirements and selected questions', () => {
    const d = {
      ...newMinimalDraft('hr'),
      company_name: 'Synthetic studio',
      job_title: 'Frontend engineer',
      requirements: ['React experience'],
      resume_value: 'https://example.com/jobs',
    };
    const c = expandToFullConfig(d);
    expect(c.screening_questions[0]).toMatchObject({
      field_key: 'requirement_1',
      must_have: true,
      expected_answer_hint: 'yes',
    });
    expect(c.screening_questions[0].question).toContain('React experience');
    expect(c.salary_range_text).toBe('');
    expect(c.fact_sheet).not.toContain('salary');
  });
  it('refuses sensitive questions and invalid calling hours', () => {
    const d = {
      ...newMinimalDraft('hr'),
      company_name: 'Synthetic studio',
      job_title: 'Engineer',
      requirements: ['Marital status'],
    };
    expect(() => expandToFullConfig(d)).toThrow();
    const sales = {
      ...newMinimalDraft('sales'),
      company_name: 'Synthetic studio',
      offering: 'A workspace',
      start: '25:00',
    };
    expect(() => expandToFullConfig(sales)).toThrow();
    expect(
      campaignDraftMinimalSchema.safeParse({ ...sales, start: '21:00', end: '05:00' }).success,
    ).toBe(true);
  });
  it('does not convert a chosen destination into an automatic message claim', () => {
    const d = {
      ...newMinimalDraft('hr'),
      company_name: 'Synthetic studio',
      job_title: 'Engineer',
      requirements: ['React experience'],
      resume_channel: 'whatsapp' as const,
      resume_value: '+12025550101',
    };
    const c = expandToFullConfig(d);
    expect(c.resume_submission.instructions).toContain('+12025550101');
    expect(c.follow_up_message_template).toBe('');
  });
  it('keeps advanced safety limits and validates their final values', () => {
    const d = {
      ...newMinimalDraft('sales'),
      company_name: 'Synthetic studio',
      offering: 'A workspace',
    };
    const base = expandToFullConfig(d);
    base.schedule.daily_minutes = 5;
    const expanded = expandToFullConfig(d, { base });
    expect(expanded.schedule.daily_minutes).toBe(5);
    expect(expanded.compliance.attested).toBe(false);
  });
  it('preserves existing allowlists, grounding and test mode when editing', () => {
    const d = {
      ...newMinimalDraft('sales'),
      company_name: 'Synthetic studio',
      offering: 'A workspace',
    };
    const base = expandToFullConfig(d);
    base.compliance.allowlist = ['+12025550101'];
    base.compliance.test_mode = false;
    base.fact_sheet = 'Approved workspace policy';
    base.qualification_questions = [
      {
        question: 'What should the team follow up on?',
        field_key: 'follow_up',
        required: false,
        must_have: false,
        expected_answer_hint: '',
      },
    ];
    const edited = expandToFullConfig(d, { base, contacts: [] });
    expect(edited.compliance.allowlist).toEqual(base.compliance.allowlist);
    expect(edited.compliance.test_mode).toBe(false);
    expect(edited.fact_sheet).toBe(base.fact_sheet);
    expect(edited.qualification_questions).toEqual(base.qualification_questions);
  });
});
