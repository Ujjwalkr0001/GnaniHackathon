import { afterEach, expect, it, vi } from 'vitest';
import twilio from 'twilio';
import type { FastifyRequest } from 'fastify';
import { defaultCampaign } from '../../packages/shared/src/index.js';
import {
  dialogueConfig,
  gnaniSttKey,
  gnaniTtsKey,
  liveReadiness,
  requireLiveCalling,
} from '../../apps/server/src/provider-config.js';
import { validTwilio } from '../../apps/server/src/security.js';
import { analyzeCall } from '../../apps/server/src/analysis.js';
import { CompatibleDialogue } from '../../apps/server/src/providers/dialogue.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('maps hackathon speech keys and Groq to the live providers', () => {
  vi.stubEnv('GNANI_API_KEY', '');
  vi.stubEnv('GNANI_STT', 'stt-synthetic');
  vi.stubEnv('GNANI_TTS', 'tts-synthetic');
  vi.stubEnv('GROQ_API_KEY', 'groq-synthetic');
  vi.stubEnv('OPENAI_API_KEY', 'openai-synthetic');
  vi.stubEnv('DIALOGUE_API_KEY', '');
  vi.stubEnv('DIALOGUE_PROVIDER', '');
  vi.stubEnv('DIALOGUE_MODEL', '');
  vi.stubEnv('DIALOGUE_URL', '');
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC-synthetic');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'synthetic-token');
  vi.stubEnv('TWILIO_PHONE_NUMBER', '+12025550101');
  vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:3000');
  vi.stubEnv('TWILIO_WEBHOOK_BASE_URL', 'https://demo.example.test');
  expect(gnaniSttKey()).toBe('stt-synthetic');
  expect(gnaniTtsKey()).toBe('tts-synthetic');
  expect(dialogueConfig()).toMatchObject({
    provider: 'groq',
    key: 'groq-synthetic',
    model: 'qwen/qwen3.8-27b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
  });
  expect(Object.values(liveReadiness()).every(Boolean)).toBe(true);
  expect(requireLiveCalling).not.toThrow();
  vi.stubEnv('TWILIO_WEBHOOK_BASE_URL', '');
  expect(liveReadiness().webhook).toBe(false);
  expect(requireLiveCalling).toThrow(/webhook/);
});

it('validates Twilio against the public callback URL including WSS media', () => {
  const secret = 'synthetic-token';
  vi.stubEnv('TWILIO_AUTH_TOKEN', secret);
  vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:3000');
  vi.stubEnv('TWILIO_WEBHOOK_BASE_URL', 'https://demo.example.test');
  const body = { CallSid: 'CA-synthetic' };
  const voiceUrl = 'https://demo.example.test/twilio/voice?call_id=synthetic';
  const voiceSig = twilio.getExpectedTwilioSignature(secret, voiceUrl, body);
  expect(
    validTwilio({
      url: '/twilio/voice?call_id=synthetic',
      body,
      headers: { 'x-twilio-signature': voiceSig },
    } as unknown as FastifyRequest),
  ).toBe(true);
  const mediaSig = twilio.getExpectedTwilioSignature(
    secret,
    'wss://demo.example.test/twilio/media/',
    {},
  );
  expect(
    validTwilio({
      url: '/twilio/media',
      body: {},
      headers: { 'x-twilio-signature': mediaSig },
    } as unknown as FastifyRequest),
  ).toBe(true);
  expect(
    validTwilio({
      url: '/twilio/media',
      body: {},
      headers: { 'x-twilio-signature': 'forged' },
    } as unknown as FastifyRequest),
  ).toBe(false);
});

it('saves a grounded recruitment summary and job-related comment through Groq', async () => {
  vi.stubEnv('GROQ_API_KEY', 'synthetic-key');
  vi.stubEnv('DIALOGUE_API_KEY', '');
  vi.stubEnv('DIALOGUE_PROVIDER', '');
  vi.stubEnv('DIALOGUE_MODEL', '');
  vi.stubEnv('DIALOGUE_URL', '');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'The caller described React dashboard work.',
                job_related_comments: 'React experience was discussed; verify the project details.',
              }),
            },
          },
        ],
        usage: { total_tokens: 42 },
      }),
    ),
  );
  const result = await analyzeCall(
    defaultCampaign('hr'),
    [{ role: 'caller', text: 'I built a React dashboard.', at: new Date().toISOString() }],
    'CANDIDATE_COMPLETED',
    { requirement_1: 'yes' },
  );
  expect(result).toMatchObject({ tokens: 42, summary: expect.stringContaining('React') });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    model: 'qwen/qwen3.8-27b',
    reasoning_effort: 'none',
    max_tokens: 450,
    response_format: { type: 'json_object' },
  });
  expect(JSON.parse(String(init?.body))).toHaveProperty('temperature', 0.2);
  expect(JSON.parse(String(init?.body)).messages[1].content).toContain('CANDIDATE_COMPLETED');
});

it('accepts a streamed Groq response when optional tools are omitted', async () => {
  vi.stubEnv('GROQ_API_KEY', 'synthetic-key');
  vi.stubEnv('DIALOGUE_API_KEY', '');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('data: {"choices":[{"delta":{"content":"{\\"text\\":\\"Hello there\\"}"}}]}\n\n'),
  );
  const reply = await new CompatibleDialogue().reply(
    defaultCampaign('hr'),
    [],
    'GREETING_DISCLOSURE',
    {},
    new AbortController().signal,
    () => {},
  );
  expect(reply).toMatchObject({ text: 'Hello there', tools: [] });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    model: 'qwen/qwen3.8-27b', reasoning_effort: 'none', max_tokens: 600,
    stream: true, response_format: { type: 'json_object' },
  });
});

it('does not use the OpenAI key when the Groq key is missing', () => {
  vi.stubEnv('OPENAI_API_KEY', 'openai-synthetic');
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('DIALOGUE_API_KEY', '');
  vi.stubEnv('DIALOGUE_PROVIDER', '');
  expect(dialogueConfig()).toMatchObject({ provider: 'groq', key: '' });
  expect(liveReadiness().dialogue).toBe(false);
  vi.stubEnv('GROQ_API_KEY', 'groq-synthetic');
  expect(dialogueConfig()).toMatchObject({ provider: 'groq', key: 'groq-synthetic' });
});

it('retains the model Q&A intent independently of spoken text and follow-up consent', async () => {
  vi.stubEnv('GROQ_API_KEY', 'synthetic-key');
  vi.stubEnv('DIALOGUE_API_KEY', '');
  const content = JSON.stringify({text:'',tools:[],qa_status:'done'});
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(
    `data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`,
  ));
  const reply=await new CompatibleDialogue().reply(defaultCampaign('hr'),[], 'OBJECTIONS_QA',{},new AbortController().signal,()=>{});
  expect(reply).toMatchObject({qa_status:'done',text:'',tools:[]});
});
