import { describe, expect, it } from 'vitest';
import { defaultCampaign, campaignSchema } from '../../packages/shared/src/index.js';
import {
  agentVersion,
  CallFlow,
  complianceGate,
  eligibility,
  nextCallingWindow,
  normalizePhone,
  opening,
  percentile,
  promptBuilder,
  safeReply,
  validateFields,
} from '../../apps/server/src/domain.js';
import {
  linearToMulaw,
  pcmToMulaw,
  mulawToLinearSample,
  FrameBuffer,
  sse,
} from '../../apps/server/src/audio.js';
import {
  maskPhone,
  privateAddress,
  redactSensitive,
  webhookSignature,
} from '../../apps/server/src/security.js';
const c = defaultCampaign();
c.compliance = { test_mode: true, attested: true, allowlist: ['+12025550101'] };
const context = {
  now: new Date('2026-11-07T06:30:00Z'),
  suppressed: false,
  attempts: 0,
  duplicate: false,
  today: 0,
  minutes: 0,
  stt: 0,
  tts: 0,
  globalPaused: false,
  globalMinutes: 0,
  globalCap: 100,
};
describe('ComplianceGate', () => {
  it('permits valid consented test number in window', () =>
    expect(complianceGate(c, '+12025550101', context)).toEqual([]));
  for (const [key, value, reason] of [
    ['suppressed', true, 'Suppressed'],
    ['attempts', 2, 'Maximum attempts'],
    ['duplicate', true, 'Duplicate'],
    ['today', 50, 'Daily usage'],
    ['globalPaused', true, 'kill switch'],
    ['minutes', 100, 'Daily usage'],
    ['stt', 6000, 'Daily usage'],
    ['tts', 100000, 'Daily usage'],
    ['globalMinutes', 100, 'Daily usage'],
  ] as const) {
    it(`blocks ${key}`, () =>
      expect(complianceGate(c, '+12025550101', { ...context, [key]: value }).join(',')).toContain(
        reason,
      ));
  }
  it('blocks unattested campaigns, invalid and non-allowlisted numbers', () => {
    expect(
      complianceGate(
        { ...c, compliance: { ...c.compliance, attested: false } },
        '+12025550101',
        context,
      ).join(','),
    ).toContain('attestation');
    expect(complianceGate(c, '+12025550102', context).join(',')).toContain('allowlisted');
    expect(complianceGate(c, '123', context).join(',')).toContain('Invalid');
  });
  it('honors 09:00 inclusive and 21:00 exclusive IST boundaries', () => {
    for (const [time, allowed] of [
      ['03:29:59', false],
      ['03:30:00', true],
      ['15:29:59', true],
      ['15:30:00', false],
    ] as const)
      expect(
        complianceGate(c, '+12025550101', { ...context, now: new Date(`2026-11-07T${time}Z`) })
          .length === 0,
      ).toBe(allowed);
  });
  it('deferred calls return to the next allowed window', () => {
    expect(nextCallingWindow(c, new Date('2026-11-07T02:00:00Z')).toISOString()).toBe(
      '2026-11-07T03:30:00.000Z',
    );
    expect(nextCallingWindow(c, new Date('2026-11-07T16:00:00Z')).toISOString()).toBe(
      '2026-11-08T03:30:00.000Z',
    );
  });
  it('allows calls through midnight and schedules the next overnight window', () => {
    const overnight = { ...c, schedule: { ...c.schedule, start: '21:00', end: '05:00' } };
    for (const [time, allowed] of [
      ['2026-11-07T15:29:00Z', false],
      ['2026-11-07T15:30:00Z', true],
      ['2026-11-07T23:29:00Z', true],
      ['2026-11-07T23:30:00Z', false],
    ] as const)
      expect(
        complianceGate(overnight, '+12025550101', { ...context, now: new Date(time) }).length === 0,
      ).toBe(allowed);
    expect(nextCallingWindow(overnight, new Date('2026-11-08T00:30:00Z')).toISOString()).toBe(
      '2026-11-08T15:30:00.000Z',
    );
  });
  it('schema accepts late and overnight windows but rejects invalid times', () => {
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, start: '09:90' } }).success,
    ).toBe(false);
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, end: '22:00' } }).success,
    ).toBe(true);
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, start: '21:00', end: '05:00' } }).success,
    ).toBe(true);
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, start: '24:00' } }).success,
    ).toBe(false);
    expect(
      campaignSchema.safeParse({ ...c, schedule: { ...c.schedule, end: c.schedule.start } }).success,
    ).toBe(false);
  });
});
describe('PromptBuilder and flow', () => {
  it('contains immutable disclosure, grounding, pricing, HR constraints and tool keys', () => {
    const hr = defaultCampaign('hr');
    const prompt = promptBuilder(hr);
    for (const phrase of [
      'AI disclosure',
      'ONLY approved',
      'Never invent',
      'humans decide',
      'mark_do_not_call',
      'Price policy none',
    ])
      expect(prompt).toContain(phrase);
    expect(opening(hr)).toContain('an AI assistant calling on behalf of');
    expect(agentVersion(hr)).toMatch(/^v1-/);
    expect(promptBuilder(hr)).toMatchSnapshot();
  });
  it('disallows skipping stages and incomplete screening', () => {
    const flow = new CallFlow();
    expect(() => flow.advance('CLOSE')).toThrow();
    flow.advance('PERMISSION');
    flow.advance('DISCOVERY_SCREENING');
    expect(() => flow.advance('PITCH_ROLE_INTRO', false)).toThrow();
  });
  it('unknown price and prohibited guarantee are referred to human', () => {
    expect(safeReply(c, 'The price is 9999.')).toContain('follow up');
    expect(safeReply(c, 'I guarantee selection')).toContain('follow up');
  });
});
describe('field validation and eligibility', () => {
  const hr = defaultCampaign('hr');
  hr.screening_questions = [
    {
      question: 'Can you use TypeScript?',
      field_key: 'typescript',
      required: true,
      must_have: true,
      expected_answer_hint: 'yes',
    },
  ];
  it('rejects unknown, sensitive and unconsented fields', () => {
    expect(() => validateFields(hr, { religion: 'Hindu' }, '')).toThrow();
    expect(() => validateFields(hr, { typescript: 'Hindu' }, '')).toThrow();
    expect(() => validateFields(hr, { consent_to_follow_up: true }, 'no')).toThrow();
    expect(validateFields(hr, { consent_to_follow_up: true }, 'Yes, I agree')).toEqual({
      consent_to_follow_up: true,
    });
  });
  it('does not accept a negated yes as consent', () =>
    expect(() => validateFields(hr, { consent_to_follow_up: true }, 'not yes, no')).toThrow());
  it('deterministic eligibility against explicit answers', () => {
    expect(eligibility(hr, { typescript: 'yes' }).value).toBe('MEETS_ALL_MUST_HAVES');
    expect(eligibility(hr, { typescript: 'no' }).value).toBe('DOES_NOT_MEET');
    expect(eligibility(hr, {}).value).toBe('UNCLEAR');
  });
  it('sensitive volunteered utterances omitted before model/persistence', () =>
    expect(redactSensitive('I am married and Hindu.', true)).toBe(
      '[Sensitive personal detail omitted]',
    ));
});
describe('codec, framing, privacy and signatures', () => {
  it('G.711 known vectors, silence and bounded round-trip error', () => {
    expect(linearToMulaw(0)).toBe(255);
    expect(linearToMulaw(1000)).toBe(206);
    expect(linearToMulaw(-1000)).toBe(78);
    for (const n of [-32000, -10000, -1000, 0, 1000, 10000, 32000])
      expect(Math.abs(mulawToLinearSample(linearToMulaw(n)) - n)).toBeLessThan(650);
    expect(() => pcmToMulaw(Buffer.alloc(3))).toThrow();
  });
  it('frames are exactly 20ms μ-law and 1024-byte STT', () => {
    const frames = new FrameBuffer(160);
    expect(frames.push(Buffer.alloc(325))).toHaveLength(2);
    const tail = frames.flush(255)[0];
    expect(tail.length).toBe(160);
    expect(tail[159]).toBe(255);
    expect(new FrameBuffer(1024).push(Buffer.alloc(3200))).toHaveLength(3);
  });
  it('masks phone/email and validates real E.164', () => {
    expect(maskPhone('Call +12025550101 test@example.com')).not.toContain('202555');
    expect(maskPhone('test@example.com')).not.toContain('@');
    expect(normalizePhone('+12025550101')).toBe('+12025550101');
    expect(normalizePhone('12025550101')).toBeUndefined();
  });
  it('blocks private webhook destinations and signs exact bytes', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      '::ffff:127.0.0.1',
    ])
      expect(privateAddress(ip)).toBe(true);
    expect(privateAddress('8.8.8.8')).toBe(false);
    expect(webhookSignature('{}', '123', 'secret')).toBe(webhookSignature('{}', '123', 'secret'));
    expect(webhookSignature('{ }', '123', 'secret')).not.toBe(
      webhookSignature('{}', '123', 'secret'),
    );
  });
  it('parses fragmented multi-line SSE and completion', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: chunk\ndata: {"audio":'));
        controller.enqueue(new TextEncoder().encode('"/w=="}\n\nevent: complete\ndata: {}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of sse(new Response(stream))) events.push(event);
    expect(events.map((e) => e.event)).toEqual(['chunk', 'complete']);
  });
  it('percentiles are actual observations or null', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
  });
});
