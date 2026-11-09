import { z } from 'zod';
import {
  campaignSchema,
  callingTimeSchema,
  defaultCampaign,
  languageSchema,
  questionSchema,
  type Campaign,
  type Contact,
} from './index.js';
export const screeningPresets = {
  notice_period: { label: 'Notice period', question: 'What is your notice period?' },
  expected_salary: {
    label: 'Expected salary',
    question: 'What are your salary expectations for this role?',
  },
  current_location: { label: 'Current location', question: 'Which city would you work from?' },
  interview_availability: {
    label: 'Interview availability',
    question: 'When are you available for an interview?',
  },
  relevant_experience: {
    label: 'Relevant experience',
    question: 'What relevant experience would you like to share?',
  },
} as const;
export const minimalBaseSchema = z.object({
  type: z.enum(['sales', 'hr']),
  company_name: z.string().trim().max(120),
  offering: z.string().trim().max(5000).default(''),
  price: z.string().trim().max(500).default(''),
  goal: z
    .enum(['collect interest', 'book demo', 'schedule callback', 'direct sale link'])
    .default('collect interest'),
  languages: z
    .array(languageSchema)
    .min(1, 'Choose at least one language.')
    .max(4, 'Choose up to four languages.'),
  job_title: z.string().trim().max(200).default(''),
  location: z.string().trim().max(200).default(''),
  work_mode: z.enum(['onsite', 'hybrid', 'remote']).default('hybrid'),
  requirements: z.array(z.string().trim().min(2).max(200)).max(12).default([]),
  screening: z
    .array(
      z.enum([
        'notice_period',
        'expected_salary',
        'current_location',
        'interview_availability',
        'relevant_experience',
      ]),
    )
    .default(['notice_period', 'interview_availability', 'relevant_experience']),
  custom_questions: z.array(questionSchema).max(20).default([]),
  resume_channel: z.enum(['whatsapp', 'email', 'link']).default('link'),
  resume_value: z.string().trim().max(500).default(''),
  pay_range: z.string().trim().max(500).default(''),
  consent: z.boolean().default(false),
  start: callingTimeSchema.default('10:00'),
  end: callingTimeSchema.default('19:00'),
});
export const campaignDraftMinimalSchema = minimalBaseSchema.superRefine((d, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (d.company_name.length < 2) issue('company_name', 'Enter your company name.');
  if (d.start === d.end) issue('end', 'Calling start and end times must differ.');
  if (d.type === 'sales' && d.offering.length < 3)
    issue('offering', 'Describe the offer in a few words.');
  if (d.type === 'hr' && !d.job_title) issue('job_title', 'Enter the job title.');
  if (d.type === 'hr' && !d.requirements.length)
    issue('requirements', 'Add at least one job-related requirement.');
  if (d.requirements.length + d.screening.length + d.custom_questions.length > 20)
    issue('requirements', 'Use up to 20 requirements and screening questions in total.');
  if (d.type === 'hr')
    for (const [i, requirement] of d.requirements.entries())
      if (
        !questionSchema.safeParse({
          question: `Do you meet this requirement: ${requirement}?`,
          field_key: `requirement_${i + 1}`,
        }).success
      )
        issue(
          'requirements',
          'Keep requirements job-related. Remove sensitive or protected attributes.',
        );
  if (
    d.resume_value &&
    d.resume_channel === 'email' &&
    !z.email().safeParse(d.resume_value).success
  )
    issue('resume_value', 'Enter a valid email address.');
  if (d.resume_value && d.resume_channel === 'link' && !z.url().safeParse(d.resume_value).success)
    issue('resume_value', 'Enter the full link, including https://.');
});
export type CampaignDraftMinimal = z.infer<typeof campaignDraftMinimalSchema>;
export function newMinimalDraft(
  type: 'sales' | 'hr',
  defaults?: { languages?: Campaign['languages'] },
): CampaignDraftMinimal {
  return minimalBaseSchema.parse({
    type,
    company_name: '',
    languages: defaults?.languages ?? ['en-IN', 'hi-IN'],
  });
}
export function expandToFullConfig(
  input: CampaignDraftMinimal,
  options: {
    contacts?: Contact[];
    advanced?: Partial<Campaign>;
    base?: Campaign;
    voice?: string;
    destinations?: string[];
  } = {},
): Campaign {
  const d = campaignDraftMinimalSchema.parse(input),
    advanced = options.advanced ?? {},
    base = options.base ?? defaultCampaign(d.type);
  const offeringName = d.offering
    .split(/[\n.!?]/)[0]
    .trim()
    .slice(0, 120);
  const name = `${d.type === 'hr' ? d.job_title : offeringName} · ${d.company_name}`.slice(0, 120);
  const jobQuestions = d.requirements.map((requirement, i) => ({
    question: `Do you meet this requirement: ${requirement}?`,
    field_key: `requirement_${i + 1}`,
    required: true,
    must_have: true,
    expected_answer_hint: 'yes',
  }));
  const presetQuestions = d.screening.map((key) => ({
    question: screeningPresets[key].question,
    field_key: key,
    required: false,
    must_have: false,
    expected_answer_hint: '',
  }));
  const facts = [
    d.company_name,
    d.type === 'sales' ? d.offering : d.job_title,
    d.type === 'sales' ? d.price : d.pay_range,
    d.type === 'hr' ? d.location : '',
    ...d.requirements,
  ].filter(Boolean);
  const full = {
    ...base,
    ...advanced,
    type: d.type,
    name: advanced.name || name,
    company_name: d.company_name,
    languages: d.languages,
    voice: {
      ...base.voice,
      ...Object.fromEntries(
        d.languages.map((l) => [
          l,
          options.voice ?? advanced.voice?.[l] ?? base.voice[l] ?? 'Shivani',
        ]),
      ),
    },
    handoff: advanced.handoff ?? (options.base ? base.handoff : 'none'),
    recording: false,
    product_name: d.type === 'sales' ? offeringName : '',
    product_description: d.type === 'sales' ? d.offering : '',
    price_text: d.price,
    call_goal: d.goal,
    job_title: d.job_title,
    location: d.location,
    work_mode: d.work_mode,
    required_skills: d.requirements.map((name) => ({ name, must_have: true })),
    salary_range_text: d.pay_range,
    role_summary:
      advanced.role_summary ||
      (options.base ? base.role_summary : '') ||
      (d.type === 'hr'
        ? [d.job_title, d.location, d.work_mode, ...d.requirements].filter(Boolean).join('. ')
        : ''),
    screening_questions: advanced.screening_questions ?? [
      ...jobQuestions,
      ...presetQuestions,
      ...d.custom_questions,
    ],
    qualification_questions:
      advanced.qualification_questions ??
      (options.base
        ? base.qualification_questions
        : [
            {
              question: 'What would you like the team to follow up on?',
              field_key: 'interest_details',
              required: false,
              must_have: false,
              expected_answer_hint: '',
            },
          ]),
    fact_sheet: advanced.fact_sheet ?? (options.base ? base.fact_sheet : facts.join('\n')),
    resume_submission: {
      ...base.resume_submission,
      channel: d.resume_channel,
      value: d.resume_value,
      instructions:
        advanced.resume_submission?.instructions ??
        (options.base && d.resume_value === base.resume_submission.value
          ? base.resume_submission.instructions
          : d.resume_value
            ? `Submit your resume here: ${d.resume_value}`
            : ''),
      deadline: advanced.resume_submission?.deadline ?? base.resume_submission.deadline,
    },
    schedule: { ...base.schedule, ...advanced.schedule, start: d.start, end: d.end },
    compliance: {
      ...base.compliance,
      ...advanced.compliance,
      attested: d.consent,
      test_mode:
        advanced.compliance?.test_mode ?? (options.base ? base.compliance.test_mode : true),
      allowlist: advanced.compliance?.allowlist ?? [
        ...new Set([
          ...(options.base ? base.compliance.allowlist : []),
          ...(options.contacts?.map((c) => c.phone) ?? []),
        ]),
      ],
    },
    destination_ids: advanced.destination_ids ?? options.destinations ?? base.destination_ids,
  };
  return campaignSchema.parse(full);
}
export function minimalFromFull(c: Campaign): CampaignDraftMinimal {
  return minimalBaseSchema.parse({
    type: c.type,
    company_name: c.company_name,
    offering: c.product_description || c.product_name,
    price: c.price_text,
    goal: c.call_goal,
    languages: c.languages,
    job_title: c.job_title,
    location: c.location,
    work_mode: c.work_mode,
    requirements: c.required_skills.map((s) => s.name),
    screening: Object.keys(screeningPresets).filter((key) =>
      c.screening_questions.some((q) => q.field_key === key),
    ),
    custom_questions: c.screening_questions.filter(
      (q) => !(q.field_key in screeningPresets) && !/^requirement_\d+$/.test(q.field_key),
    ),
    resume_channel: c.resume_submission.channel,
    resume_value: c.resume_submission.value,
    pay_range: c.salary_range_text,
    start: c.schedule.start,
    end: c.schedule.end,
    consent: c.compliance.attested,
  });
}
export function draftFacts(d: CampaignDraftMinimal) {
  return [
    d.company_name,
    d.type === 'sales' ? d.offering : d.job_title,
    d.type === 'sales' ? d.price : d.pay_range,
    d.type === 'hr' ? d.location : '',
    ...d.requirements,
  ].filter((s) => s.trim());
}
