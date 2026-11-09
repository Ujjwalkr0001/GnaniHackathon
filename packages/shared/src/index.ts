import { z } from 'zod';

export const languages = [
  'en-IN',
  'hi-IN',
  'te-IN',
  'ta-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'pa-IN',
  'bn-IN',
  'gu-IN',
] as const;
export const voices = [
  'Shivani',
  'Avinash',
  'Lakshmi',
  'Kalpana',
  'Shubham',
  'Prakash',
  'Devansh',
  'Yashraj',
  'Chetana',
  'Vasudha',
  'Riyaa',
  'Tarika',
  'Harshad',
] as const;
export const languageSchema = z.enum(languages);
export const callingTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.');
export function isWithinCallingWindow(time: string, start: string, end: string) {
  if (start === end) return false;
  if (start < end) return time >= start && time < end;
  return time >= start || time < end;
}
const text = z.string().trim().max(5000);
const list = z.array(text).max(50).default([]);
const sensitive =
  /religio|caste|marital|pregnan|disabil|health|sexual|ethnic|\brace\b|\bage\b|date.of.birth|penis|genital|breast.size|body.measurement/i;
export const isJobRelatedQuestion = (q: { field_key: string; question: string }) =>
  !sensitive.test(`${q.field_key} ${q.question}`);
export const questionSchema = z
  .object({
    question: z.string().min(3).max(500),
    field_key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    required: z.boolean().default(false),
    must_have: z.boolean().default(false),
    expected_answer_hint: text.default(''),
  })
  .refine(
      isJobRelatedQuestion,
    'Only job-related, non-sensitive fields are allowed',
  );
export const campaignSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    type: z.enum(['sales', 'hr']),
    company_name: z.string().trim().min(2).max(120),
    company_about: text.default(''),
    website: z.union([z.string().url(), z.literal('')]).optional(),
    languages: z.array(languageSchema).min(1).max(4).default(['en-IN']),
    agent_persona: z
      .object({
        name: z.string().min(1).max(40),
        tone: z.enum(['formal', 'friendly', 'energetic']),
      })
      .default({ name: 'Mira', tone: 'friendly' }),
    voice: z.partialRecord(languageSchema, z.enum(voices)).default({ 'en-IN': 'Shivani' }),
    opening_style: text.default('Brief and respectful'),
    callback_number_or_contact: text.default('The team will follow up'),
    handoff: z.enum(['none', 'callback']).default('callback'),
    fact_sheet: text.default(''),
    key_facts: list,
    faqs: z
      .array(z.object({ q: text, a: text }))
      .max(30)
      .default([]),
    do_not_say: list,
    max_call_duration_s: z.number().int().min(30).max(600).default(240),
    recording: z.literal(false).default(false),
    schedule: z
      .object({
        start: callingTimeSchema.default('09:00'),
        end: callingTimeSchema.default('21:00'),
        timezone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
        max_attempts: z.number().int().min(1).max(2).default(2),
        retry_gap_min: z.number().int().min(30).default(60),
        concurrency: z.number().int().min(1).max(10).default(2),
        daily_cap: z.number().int().min(1).max(200).default(50),
        daily_minutes: z.number().positive().max(1000).default(100),
        daily_stt_seconds: z.number().positive().default(6000),
        daily_tts_chars: z.number().positive().default(100000),
      })
      .prefault({}),
    compliance: z
      .object({
        attested: z.boolean().default(false),
        test_mode: z.boolean().default(true),
        allowlist: z.array(z.string()).max(200).default([]),
      })
      .prefault({}),
    product_name: text.default(''),
    product_description: text.default(''),
    target_audience: text.default(''),
    key_benefits: list,
    price_text: text.default(''),
    price_flexibility: z.enum(['none', 'scripted_discount', 'escalate']).default('none'),
    discount_max_percent: z.number().min(0).max(100).default(0),
    discount_conditions: text.default(''),
    offer: text.default(''),
    offer_expiry: text.default(''),
    call_goal: z
      .enum(['book demo', 'collect interest', 'schedule callback', 'direct sale link'])
      .default('collect interest'),
    qualification_questions: z.array(questionSchema).max(20).default([]),
    objection_playbook: z
      .array(z.object({ objection: text, response: text }))
      .max(30)
      .default([]),
    disqualifiers: list,
    cta: text.default('Ask permission for the team to follow up'),
    follow_up_message_template: text.default(''),
    job_title: text.default(''),
    job_listing_ref: text.default(''),
    department: text.default(''),
    location: text.default(''),
    work_mode: z.enum(['onsite', 'hybrid', 'remote']).default('hybrid'),
    employment_type: text.default('Full-time'),
    openings: z.number().int().positive().default(1),
    experience_range: text.default(''),
    required_skills: z.array(z.object({ name: text, must_have: z.boolean() })).default([]),
    nice_to_have: list,
    salary_range_text: text.default(''),
    notice_period_preference: text.default(''),
    role_summary: text.default(''),
    interview_process_text: text.default(''),
    screening_questions: z.array(questionSchema).max(20).default([]),
    eligibility_rules: list,
    resume_submission: z
      .object({
        channel: z.enum(['whatsapp', 'email', 'link']),
        value: text,
        instructions: text,
        deadline: text.default(''),
      })
      .prefault({ channel: 'link', value: '', instructions: '' }),
    hiring_contact_name: text.default(''),
    destination_ids: z.array(z.string().uuid()).default([]),
    sample: z.boolean().default(false),
  })
  .superRefine((c, ctx) => {
    if (c.schedule.start === c.schedule.end)
      ctx.addIssue({
        code: 'custom',
        path: ['schedule'],
        message: 'Calling start and end times must differ.',
      });
    const questions = c.type === 'hr' ? c.screening_questions : c.qualification_questions;
    if (new Set(questions.map((q) => q.field_key)).size !== questions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['screening_questions'],
        message: 'Field keys must be unique',
      });
    if (c.type === 'hr' && (!c.job_title || !c.role_summary))
      ctx.addIssue({
        code: 'custom',
        path: ['job_title'],
        message: 'Job title and role summary are required',
      });
    if (c.type === 'sales' && !c.product_name)
      ctx.addIssue({ code: 'custom', path: ['product_name'], message: 'Product name is required' });
    for (const lang of c.languages)
      if (!c.voice[lang])
        ctx.addIssue({ code: 'custom', path: ['voice'], message: `Choose a voice for ${lang}` });
  });
export type Campaign = z.infer<typeof campaignSchema>;
export const contactSchema = z.object({
  phone: z.string().max(30),
  first_name: z.string().max(80).default(''),
  candidate_name: text.default(''),
  current_role: text.default(''),
  source: text.default(''),
  language: languageSchema.optional(),
  sample: z.boolean().default(false),
});
export type Contact = z.infer<typeof contactSchema>;
export const outcomes = [
  'INTERESTED_HOT',
  'INTERESTED_WARM',
  'NOT_INTERESTED',
  'CALLBACK',
  'DO_NOT_CALL',
  'WRONG_NUMBER',
  'VOICEMAIL',
  'NO_ANSWER',
  'INCOMPLETE',
  'FAILED',
  'CANDIDATE_COMPLETED',
  'CANDIDATE_DECLINED',
  'CANDIDATE_REQUIREMENTS_NOT_MET',
] as const;
export type Outcome = (typeof outcomes)[number];
export const stages = [
  'GREETING_DISCLOSURE',
  'PERMISSION',
  'DISCOVERY_SCREENING',
  'PITCH_ROLE_INTRO',
  'OBJECTIONS_QA',
  'CLOSE',
  'WRAP_UP',
] as const;
export type Stage = (typeof stages)[number];
export type Role = 'admin' | 'viewer';
export interface Row<T = Record<string, unknown>> {
  id: string;
  org_id: string;
  data: T;
  created_at: string;
  updated_at: string;
}
export interface Turn {
  role: 'agent' | 'caller';
  text: string;
  at: string;
}
export interface Latency {
  route?: 'structured' | 'dialogue' | 'control';
  stt_final_to_audio_ms?: number;
  tts_cache_hit?: boolean;
  end_of_speech_to_audio_ms?: number;
  stt_final_ms?: number;
  llm_first_token_ms?: number;
  tts_first_byte_ms?: number;
}
export interface CallResult {
  campaign_id: string;
  contact_id?: string;
  outcome: Outcome;
  end_reason?: string;
  summary: string;
  extracted_fields: Record<string, string | boolean | number>;
  sentiment: 'unknown';
  languages: string[];
  transcript: Turn[];
  tool_log: { name: string; args: unknown; result: unknown; at: string }[];
  latency: Latency[];
  usage: { stt_seconds: number; tts_chars: number; llm_tokens: number; telephony_minutes: number };
  provider_trace: { provider: string; event: string; at: string }[];
  eligibility?: { value: string; reasons: string[] };
  recommendation?: string;
  agent_version: string;
  sample: boolean;
  simulation: boolean;
  duration_s: number;
  follow_up_eligible: boolean;
}
export const destinationSchema = z.object({
  name: z.string().min(2).max(100),
  kind: z.literal('webhook'),
  url: z.string().url().startsWith('https://'),
  enabled: z.boolean().default(true),
});
export type Destination = z.infer<typeof destinationSchema>;
export function defaultCampaign(type: 'sales' | 'hr' = 'sales'): Campaign {
  return campaignSchema.parse({
    name: 'Untitled campaign',
    company_name: 'Your company',
    type,
    product_name: type === 'sales' ? 'Your product' : '',
    job_title: type === 'hr' ? 'Your role' : '',
    role_summary: type === 'hr' ? 'Describe the role and requirements.' : '',
  });
}
