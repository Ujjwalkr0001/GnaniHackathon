import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Clock3,
  Megaphone,
  Mic,
} from 'lucide-react';
import { z } from 'zod';
import {
  campaignSchema,
  languages,
  voices,
  type Campaign,
  type Contact,
} from '../../../../packages/shared/src/index.js';
import {
  campaignDraftMinimalSchema,
  draftFacts,
  expandToFullConfig,
  minimalFromFull,
  newMinimalDraft,
  screeningPresets,
  type CampaignDraftMinimal,
} from '../../../../packages/shared/src/minimal.js';
import { useApp } from '../App.js';
import { api, csrf } from '../api.js';
import { DEFAULTS_KEY, DRAFT_ENDPOINT, DRAFT_KEY } from '../config.js';
import {
  change,
  query,
  readLocal,
  useData,
  writeLocal,
  type CampaignRow,
  type DestinationRow,
} from '../data.js';
import { copy, languageNames } from '../strings.js';
import {
  Button,
  Card,
  Chip,
  Disclosure,
  Field,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  Stepper,
  TagInput,
  Textarea,
} from '../ui/index.js';
import AgentPreview from '../components/AgentPreview.js';
import ContactInput, { type Validation } from '../components/ContactInput.js';
import { BrowserTest } from '../components/Conversation.js';
interface SavedDraft {
  draft: CampaignDraftMinimal;
  raw: string;
  contacts: Contact[];
  advanced: Partial<Campaign>;
  step: number;
  savedId?: string;
  drafted?: boolean;
}
const getSaved = () => readLocal<SavedDraft | null>(DRAFT_KEY, null);
export default function Wizard() {
  const { workflow, id } = useParams();
  if (!workflow && !id) return <Entry />;
  return (
    <WizardForm key={id ?? workflow} type={workflow === 'hr' ? 'hr' : 'sales'} editingId={id} />
  );
}
function Entry() {
  const navigate = useNavigate(),
    saved = getSaved(),
    [description, setDescription] = useState(''),
    [language, setLanguage] = useState('en-IN'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="entry">
      <span className="eyebrow">New campaign</span>
      <h1 style={{ marginTop: 12 }}>{copy.entry}</h1>
      <p style={{ marginTop: 16 }}>{copy.entryIntro}</p>
      <div className="choice-grid">
        {(['sales', 'hr'] as const).map((type) => (
          <Link className="choice" to={`/campaigns/new/${type}`} key={type}>
            {type === 'sales' ? <Megaphone size={24} /> : <BriefcaseBusiness size={24} />}
            <div>
              <h2>{type === 'sales' ? copy.sales : copy.hr}</h2>
              <p>{type === 'sales' ? copy.salesDescription : copy.hrDescription}</p>
            </div>
            <ArrowRight size={18} />
          </Link>
        ))}
      </div>
      {saved && (
        <p className="helper" style={{ marginTop: 24 }}>
          You have a saved draft.{' '}
          <Link className="link" to={`/campaigns/new/${saved.draft.type}`}>
            Continue it
          </Link>
        </p>
      )}
      {DRAFT_ENDPOINT && (
        <form
          className="description-entry"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setMessage('');
            void (async () => {
              if (!DRAFT_ENDPOINT.startsWith('/api/'))
                throw new Error('Description drafting needs a configured same-origin endpoint.');
              const response = await fetch(DRAFT_ENDPOINT, {
                method: 'POST',
                signal: AbortSignal.timeout(12000),
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
                body: JSON.stringify({ description, language }),
              });
              if (!response.ok)
                throw new Error('Drafting is unavailable. Choose a type to continue.');
              const data = z
                .object({
                  type: z.enum(['sales', 'hr']),
                  company_name: z.string().optional(),
                  offering: z.string().optional(),
                  job_title: z.string().optional(),
                  location: z.string().optional(),
                  requirements: z.array(z.string()).optional(),
                })
                .strict()
                .parse(await response.json());
              const draft = newMinimalDraft(data.type);
              for (const key of ['company_name', 'offering', 'job_title', 'location'] as const) {
                if (data[key] && description.toLowerCase().includes(data[key].toLowerCase()))
                  draft[key] = data[key];
              }
              draft.requirements =
                data.requirements?.filter((r) =>
                  description.toLowerCase().includes(r.toLowerCase()),
                ) ?? [];
              draft.languages = [language as Campaign['languages'][number]];
              writeLocal(DRAFT_KEY, {
                draft,
                raw: '',
                contacts: [],
                advanced: {},
                step: 0,
                drafted: true,
              });
              navigate(`/campaigns/new/${data.type}`);
            })()
              .catch((e) => setMessage(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Or describe it in your own words">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
          </Field>
          <div className="row between">
            <Select
              aria-label="Description language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              style={{ width: 140 }}
            >
              {languages.map((l) => (
                <option value={l} key={l}>
                  {languageNames[l]}
                </option>
              ))}
            </Select>
            <Button disabled={busy}>Draft the details</Button>
          </div>
          {message && (
            <p className="helper" role="status">
              {message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
function WizardForm({ type, editingId }: { type: 'sales' | 'hr'; editingId?: string }) {
  const navigate = useNavigate(),
    { notify } = useApp(),
    initial = useRef(getSaved()),
    defaults = useRef(
      readLocal<{ languages: Campaign['languages']; voice: string }>(DEFAULTS_KEY, {
        languages: ['en-IN', 'hi-IN'],
        voice: 'Shivani',
      }),
    ),
    same = initial.current?.draft.type === type && !editingId ? initial.current : undefined;
  const [draft, setDraft] = useState<CampaignDraftMinimal>(
      same?.draft ?? newMinimalDraft(type, defaults.current),
    ),
    [step, setStep] = useState(same?.step ?? 0),
    [raw, setRaw] = useState(same?.raw ?? ''),
    [contacts, setContacts] = useState<Contact[]>(same?.contacts ?? []),
    [advanced, setAdvanced] = useState<Partial<Campaign>>(same?.advanced ?? {}),
    [base, setBase] = useState<Campaign>(),
    [savedId, setSavedId] = useState(editingId ?? same?.savedId),
    [validation, setValidation] = useState<Validation[]>([]),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!editingId),
    [test, setTest] = useState<CampaignRow>(),
    [fine, setFine] = useState(false),
    [hours, setHours] = useState(false),
    [draftSaved, setDraftSaved] = useState(true);
  const imported = useRef(''),
    destinations = useData<DestinationRow[]>('/destinations');
  const onValidation = useCallback((rows: Validation[]) => setValidation(rows), []);
  useEffect(() => {
    if (editingId)
      void api<CampaignRow>(`/campaigns/${editingId}`)
        .then((row) => {
          setBase(row.data);
          setDraft(minimalFromFull(row.data));
          setLoading(false);
        })
        .catch((e) => {
          notify(e.message);
          setLoading(false);
        });
  }, [editingId, notify]);
  useEffect(() => {
    if (!loading)
      setDraftSaved(
        writeLocal(DRAFT_KEY, {
          draft,
          raw,
          contacts,
          advanced,
          step,
          savedId,
          drafted: same?.drafted,
        }),
      );
  }, [draft, raw, contacts, advanced, step, savedId, loading]);
  useEffect(() => {
    window.scrollTo(0, 0);
    setErrors({});
  }, [step]);
  const set = <K extends keyof CampaignDraftMinimal>(key: K, value: CampaignDraftMinimal[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const validContacts = contacts.filter((_, i) => validation[i]?.status === 'valid');
  const validate = (current: number) => {
    const parsed = campaignDraftMinimalSchema.safeParse(draft),
      next: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0]);
        if ((current === 0 && key !== 'resume_value') || (current === 1 && key === 'resume_value'))
          next[key] = issue.message;
      }
    if (current === 1 && !validContacts.length)
      next.contacts =
        'Add at least one valid contact. Invalid and do-not-call rows will not be called.';
    if (current === 1 && draft.type === 'hr' && !draft.resume_value)
      next.resume_value = 'Add the number, email or link for resume submission.';
    setErrors(next);
    return !Object.keys(next).length;
  };
  async function save() {
    const full = expandToFullConfig(draft, {
      contacts: validContacts,
      advanced,
      base,
      voice: advanced.voice || base ? undefined : defaults.current.voice,
      destinations: base
        ? undefined
        : destinations.data
            ?.filter((d) => d.data.enabled)
            .slice(0, 1)
            .map((d) => d.id),
    });
    const row = await api<CampaignRow>(
      savedId ? `/campaigns/${savedId}` : '/campaigns',
      savedId ? 'PUT' : 'POST',
      full,
    );
    setSavedId(row.id);
    if (validContacts.length && imported.current !== JSON.stringify(validContacts)) {
      const report = await api<Validation[]>(
        `/campaigns/${row.id}/contacts`,
        'POST',
        validContacts,
      );
      if (report.some((r) => r.status !== 'valid' && r.status !== 'duplicate'))
        throw new Error('Some contacts changed status. Review the list before launching.');
      imported.current = JSON.stringify(validContacts);
    }
    await query.invalidateQueries({ queryKey: ['/campaigns'] });
    await query.invalidateQueries({ queryKey: ['/contacts'] });
    return row;
  }
  async function action(launch: boolean) {
    setBusy(true);
    setErrors({});
    try {
      if (launch && !draft.consent) throw new Error('Confirm consent before launching.');
      if (launch && !validContacts.length && !editingId)
        throw new Error('Add valid contacts before launching.');
      const row = await save();
      if (launch) {
        await change(`/campaigns/${row.id}/launch`);
        localStorage.removeItem(DRAFT_KEY);
        notify('Campaign launched. Every number is checked before it is called.');
        navigate(`/campaigns/${row.id}`);
      } else setTest(row);
    } catch (e) {
      setErrors({ review: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Skeleton />;
  const captures = draft.type === 'hr' ? 'Candidates & follow-up' : 'Contacts';
  return (
    <>
      <div className="wizard-top">
        <Stepper step={step} />
        <span className="helper">
          {draftSaved ? 'Draft saved on this device' : 'Keep this page open to retain your draft'}
        </span>
      </div>
      <div className="wizard-layout">
        <Card className="wizard-form">
          <div className="wizard-intro">
            <span className="eyebrow">
              {draft.type === 'hr' ? 'HR & Recruitment' : 'Sales & Marketing'}
            </span>
            <h1 style={{ marginTop: 8 }}>
              {step === 0
                ? 'Start with the essentials.'
                : step === 1
                  ? 'Who should we call?'
                  : 'Ready for a first hello?'}
            </h1>
            <p>
              {step === 0
                ? 'A few details are all your agent needs to get started.'
                : step === 1
                  ? editingId
                    ? 'Add more contacts. Existing contacts stay in the campaign.'
                    : 'Use synthetic data or contacts who have agreed to a call.'
                  : 'Test the conversation, then launch when you’re ready.'}
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (step < 2) {
                if (validate(step)) setStep((s) => s + 1);
              } else void action(true);
            }}
          >
            {same?.drafted && (
              <p className="helper" style={{ marginBottom: 24 }}>
                Drafted from your description. Please review every field.
              </p>
            )}
            <div className="form-fields" data-testid={`wizard-step-${step}`}>
              {step === 0 && (
                <>
                  <Field label="Company name" error={errors.company_name}>
                    <Input
                      value={draft.company_name}
                      onChange={(e) => set('company_name', e.target.value)}
                      placeholder="Your company"
                      autoComplete="organization"
                    />
                  </Field>
                  {draft.type === 'sales' ? (
                    <>
                      <Field label="What are you offering?" error={errors.offering}>
                        <Textarea
                          value={draft.offering}
                          onChange={(e) => set('offering', e.target.value)}
                          placeholder="Product or service, and a short description"
                          rows={3}
                        />
                      </Field>
                      <Field
                        label="Price you can quote"
                        hint="Optional. The agent will only quote what you write here."
                      >
                        <Input
                          value={draft.price}
                          onChange={(e) => set('price', e.target.value)}
                          placeholder="Leave blank for the team to follow up"
                        />
                      </Field>
                      <div className="field" data-field-group="Call goal">
                        <span className="field-label">Goal of the call</span>
                        <SegmentedControl
                          label="Goal of the call"
                          value={draft.goal}
                          options={[
                            { value: 'book demo', label: 'Book a demo / visit' },
                            { value: 'schedule callback', label: 'Call back later' },
                            { value: 'collect interest', label: 'Collect interest' },
                            ...(draft.goal === 'direct sale link'
                              ? [{ value: 'direct sale link', label: 'Send approved link' }]
                              : []),
                          ]}
                          onChange={(v) => set('goal', v as CampaignDraftMinimal['goal'])}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="Job title" error={errors.job_title}>
                        <Input
                          value={draft.job_title}
                          onChange={(e) => set('job_title', e.target.value)}
                          placeholder="For example, Frontend engineer"
                        />
                      </Field>
                      <div className="field" data-field-group="Location & work mode">
                        <label htmlFor="job-location">Location & work mode</label>
                        <Input
                          id="job-location"
                          value={draft.location}
                          onChange={(e) => set('location', e.target.value)}
                          placeholder="City or working location"
                        />
                        <SegmentedControl
                          label="Work mode"
                          value={draft.work_mode}
                          options={['onsite', 'hybrid', 'remote'].map((v) => ({
                            value: v,
                            label: v[0].toUpperCase() + v.slice(1),
                          }))}
                          onChange={(v) => set('work_mode', v as CampaignDraftMinimal['work_mode'])}
                        />
                      </div>
                      <Field
                        label="Must-have requirements"
                        hint="Add a requirement, then press Enter. For example, 2+ years React."
                        error={errors.requirements}
                      >
                        <TagInput
                          value={draft.requirements}
                          onChange={(tags) => set('requirements', tags)}
                        />
                      </Field>
                    </>
                  )}
                  <LanguageField
                    value={draft.languages}
                    onChange={(value) => set('languages', value)}
                    error={errors.languages}
                  />
                </>
              )}
              {step === 1 && (
                <>
                  <ContactInput
                    raw={raw}
                    onRaw={setRaw}
                    contacts={contacts}
                    onContacts={(rows) => {
                      setContacts(rows);
                      setValidation([]);
                    }}
                    validation={validation}
                    onValidation={onValidation}
                    label={draft.type === 'hr' ? 'Candidates' : 'Contacts'}
                  />
                  {errors.contacts && (
                    <p role="alert" className="field-error">
                      {errors.contacts}
                    </p>
                  )}
                  {draft.type === 'hr' && (
                    <>
                      <div className="field" data-field-group="Screening questions">
                        <span className="field-label">What should we ask?</span>
                        <div className="chips" role="group" aria-label="Screening questions">
                          {Object.entries(screeningPresets).map(([key, value]) => (
                            <button
                              type="button"
                              className="language-pill"
                              key={key}
                              aria-pressed={draft.screening.includes(
                                key as (typeof draft.screening)[number],
                              )}
                              onClick={() =>
                                set(
                                  'screening',
                                  draft.screening.includes(key as (typeof draft.screening)[number])
                                    ? draft.screening.filter((k) => k !== key)
                                    : [...draft.screening, key as (typeof draft.screening)[number]],
                                )
                              }
                            >
                              {draft.screening.includes(
                                key as (typeof draft.screening)[number],
                              ) && <Check size={12} />}
                              {value.label}
                            </button>
                          ))}
                        </div>
                        <Disclosure title="Add a job-related question">
                          <Field label="Question">
                            <Input
                              id="custom-question"
                              placeholder="A question about the role"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const text = e.currentTarget.value.trim();
                                  if (text) {
                                    const next = [
                                      ...draft.custom_questions,
                                      {
                                        question: text,
                                        field_key: `custom_${draft.custom_questions.length + 1}`,
                                        required: false,
                                        must_have: false,
                                        expected_answer_hint: '',
                                      },
                                    ];
                                    set('custom_questions', next);
                                    e.currentTarget.value = '';
                                  }
                                }
                              }}
                            />
                          </Field>
                          <p className="helper">
                            Press Enter to add. {draft.custom_questions.length} custom questions.
                          </p>
                          {draft.custom_questions.map((q) => (
                            <Chip key={q.field_key}>{q.question}</Chip>
                          ))}
                        </Disclosure>
                      </div>
                      <div className="field" data-field-group="Resume submission">
                        <label htmlFor="resume-value">
                          Where should candidates send their resume?
                        </label>
                        <SegmentedControl
                          label="Resume channel"
                          value={draft.resume_channel}
                          options={[
                            { value: 'whatsapp', label: 'WhatsApp' },
                            { value: 'email', label: 'Email' },
                            { value: 'link', label: 'Link' },
                          ]}
                          onChange={(v) =>
                            set('resume_channel', v as CampaignDraftMinimal['resume_channel'])
                          }
                        />
                        <Input
                          id="resume-value"
                          type={
                            draft.resume_channel === 'email'
                              ? 'email'
                              : draft.resume_channel === 'link'
                                ? 'url'
                                : 'tel'
                          }
                          aria-invalid={!!errors.resume_value}
                          value={draft.resume_value}
                          onChange={(e) => set('resume_value', e.target.value)}
                          placeholder={
                            draft.resume_channel === 'link'
                              ? 'https://your-company.example/careers'
                              : draft.resume_channel === 'email'
                                ? 'hiring@your-company.example'
                                : '+91…'
                          }
                        />
                        {errors.resume_value && (
                          <p role="alert" className="field-error">
                            {errors.resume_value}
                          </p>
                        )}
                        <p className="helper">
                          The agent will share these instructions during the call. No automatic
                          WhatsApp message is sent.
                        </p>
                      </div>
                      <Field label="Pay range" hint="Optional. Only shared if you fill it in.">
                        <Input
                          value={draft.pay_range}
                          onChange={(e) => set('pay_range', e.target.value)}
                        />
                      </Field>
                    </>
                  )}
                </>
              )}
              {step === 2 && (
                <>
                  <dl className="review-list">
                    <div>
                      <dt>{draft.type === 'hr' ? 'Role' : 'Offer'}</dt>
                      <dd>{draft.type === 'hr' ? draft.job_title : draft.offering}</dd>
                    </div>
                    <div>
                      <dt>On behalf of</dt>
                      <dd>{draft.company_name}</dd>
                    </div>
                    <div>
                      <dt>{captures}</dt>
                      <dd>
                        {validContacts.length} valid{' '}
                        {draft.type === 'hr' ? 'candidates' : 'contacts'}
                        {editingId ? ' to add' : ''} ·{' '}
                        {draft.languages.map((l) => languageNames[l]).join(' + ')}
                      </dd>
                    </div>
                  </dl>
                  <div>
                    <button
                      type="button"
                      className="hours-button"
                      aria-expanded={hours}
                      onClick={() => setHours(!hours)}
                    >
                      <Clock3 size={14} />
                      {draft.start}–{draft.end} IST
                      <ChevronDown size={14} />
                    </button>
                    {hours && (
                      <div className="inline-grid" style={{ marginTop: 16 }}>
                        <Field label="Start time">
                          <Input
                            type="time"
                            value={draft.start}
                            onChange={(e) => set('start', e.target.value)}
                          />
                        </Field>
                        <Field label="End time">
                          <Input
                            type="time"
                            value={draft.end}
                            onChange={(e) => set('end', e.target.value)}
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                  <div className="row">
                    <span className="helper">Results go to</span>
                    <Chip>Internal workspace</Chip>
                    {destinations.data
                      ?.filter((d) => d.data.enabled)
                      .slice(0, 1)
                      .map((d) => (
                        <Chip key={d.id}>{d.data.name}</Chip>
                      ))}
                    <Link className="link text-small" to="/settings#delivery">
                      Change
                    </Link>
                  </div>
                  <div className="review-facts">
                    <p>
                      Agent knows: <strong>{draftFacts(draft).length} facts.</strong>
                    </p>
                    <p className="helper">It will refer unknown details to your team.</p>
                    <Button kind="ghost" type="button" onClick={() => setFine(!fine)}>
                      Add more in Fine-tune
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                  <label className="consent">
                    <input
                      type="checkbox"
                      checked={draft.consent}
                      onChange={(e) => set('consent', e.target.checked)}
                    />
                    <span>{copy.consent}</span>
                  </label>
                  <p className="helper">
                    {base && !base.compliance.test_mode
                      ? 'Live calling is enabled for this existing campaign. Existing compliance limits apply.'
                      : 'Test mode is on by default. Only validated numbers in this list are allowlisted.'}
                  </p>
                  <p className="helper">
                    Estimated usage: up to{' '}
                    {(
                      ((validContacts.length || 0) *
                        (advanced.max_call_duration_s ?? base?.max_call_duration_s ?? 240)) /
                      60
                    ).toLocaleString('en-IN')}{' '}
                    call minutes for one attempt per {editingId ? 'newly added contact' : 'contact'}
                    .
                  </p>
                </>
              )}
            </div>
            {(step === 0 || step === 2) && (
              <FineTune
                draft={draft}
                advanced={advanced}
                base={base}
                onChange={setAdvanced}
                open={fine}
                onToggle={setFine}
              />
            )}
            {errors.review && (
              <p role="alert" className="field-error" style={{ marginTop: 20 }}>
                {errors.review}
              </p>
            )}
            <div className={`wizard-actions ${step === 2 ? 'review-actions' : ''}`}>
              <Button
                kind="ghost"
                type="button"
                onClick={() => (step ? setStep((s) => s - 1) : navigate('/campaigns/new'))}
              >
                <ArrowLeft size={15} />
                Back
              </Button>
              {step < 2 ? (
                <Button kind="primary" type="submit">
                  Continue
                  <ArrowRight size={15} />
                </Button>
              ) : (
                <>
                  <Button type="button" disabled={busy} onClick={() => void action(false)}>
                    <Mic size={15} />
                    Test in browser
                  </Button>
                  <Button kind="primary" type="submit" disabled={busy || !draft.consent}>
                    {busy ? 'Saving…' : 'Launch'}
                  </Button>
                </>
              )}
            </div>
          </form>
        </Card>
        <AgentPreview
          draft={draft}
          name={advanced.agent_persona?.name ?? base?.agent_persona.name}
          voice={advanced.voice?.[draft.languages[0]] ?? defaults.current.voice}
        />
      </div>
      {test && <BrowserTest campaign={test} onClose={() => setTest(undefined)} />}
    </>
  );
}
export function LanguageField({
  value,
  onChange,
  error,
}: {
  value: Campaign['languages'];
  onChange: (value: Campaign['languages']) => void;
  error?: string;
}) {
  const [more, setMore] = useState(value.some((l) => !['en-IN', 'hi-IN'].includes(l)));
  return (
    <div className="field" data-field-group="Languages">
      <span className="field-label">Languages</span>
      <div className="chips" role="group" aria-label="Languages">
        {(more ? languages : languages.slice(0, 2)).map((lang) => (
          <button
            className="language-pill"
            type="button"
            key={lang}
            aria-pressed={value.includes(lang)}
            onClick={() => {
              if (value.includes(lang)) {
                if (value.length > 1) onChange(value.filter((l) => l !== lang));
              } else if (value.length < 4) onChange([...value, lang]);
            }}
          >
            {value.includes(lang) && <Check size={12} />}
            {languageNames[lang]}
          </button>
        ))}
        {!more && (
          <Button kind="ghost" type="button" onClick={() => setMore(true)}>
            More languages
          </Button>
        )}
      </div>
      <p className="helper">Starts in {languageNames[value[0]]}. Up to four languages.</p>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
function FineTune({
  draft,
  advanced,
  base,
  onChange,
  open,
  onToggle,
}: {
  draft: CampaignDraftMinimal;
  advanced: Partial<Campaign>;
  base?: Campaign;
  onChange: (value: Partial<Campaign>) => void;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const current = { ...base, ...advanced };
  const text = (
    key:
      | 'company_about'
      | 'fact_sheet'
      | 'callback_number_or_contact'
      | 'offer'
      | 'offer_expiry'
      | 'role_summary'
      | 'interview_process_text'
      | 'hiring_contact_name'
      | 'job_listing_ref',
    label: string,
  ) => (
    <Field label={label}>
      <Textarea
        rows={2}
        value={current[key] ?? ''}
        onChange={(e) => onChange({ ...advanced, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <Disclosure title="Fine-tune" open={open} onToggle={onToggle}>
      <div className="advanced-grid">
        {text('fact_sheet', 'More approved facts')}
        {text('company_about', 'About the company')}
        <Field label="FAQs" hint="One question | approved answer per line.">
          <Textarea
            value={(current.faqs ?? []).map((f) => `${f.q} | ${f.a}`).join('\n')}
            onChange={(e) =>
              onChange({
                ...advanced,
                faqs: e.target.value
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => {
                    const [q, ...a] = line.split('|');
                    return { q: q.trim(), a: a.join('|').trim() };
                  }),
              })
            }
          />
        </Field>
        {draft.type === 'sales' && (
          <>
            <Field
              label="Qualification questions"
              hint="One job- or offer-related question per line."
            >
              <Textarea
                value={(current.qualification_questions ?? []).map((q) => q.question).join('\n')}
                onChange={(e) =>
                  onChange({
                    ...advanced,
                    qualification_questions: e.target.value
                      .split('\n')
                      .filter(Boolean)
                      .map((question, i) => ({
                        question,
                        field_key: `qualification_${i + 1}`,
                        required: false,
                        must_have: false,
                        expected_answer_hint: '',
                      })),
                  })
                }
              />
            </Field>
            {text('offer', 'Approved offer')}
            {text('offer_expiry', 'Offer expiry')}
            <Field label="Approved objection replies" hint="One objection | reply per line.">
              <Textarea
                value={(current.objection_playbook ?? [])
                  .map((o) => `${o.objection} | ${o.response}`)
                  .join('\n')}
                onChange={(e) =>
                  onChange({
                    ...advanced,
                    objection_playbook: e.target.value
                      .split('\n')
                      .filter(Boolean)
                      .map((line) => {
                        const [objection, ...answer] = line.split('|');
                        return { objection: objection.trim(), response: answer.join('|').trim() };
                      }),
                  })
                }
              />
            </Field>
          </>
        )}
        {draft.type === 'hr' && (
          <>
            {text('job_listing_ref', 'Job listing reference')}
            {text('role_summary', 'Role summary')}
            {text('interview_process_text', 'Interview process')}
            {text('hiring_contact_name', 'Hiring contact')}
            <Field
              label="Nice-to-haves"
              hint="One per line. These are never must-have requirements."
            >
              <Textarea
                value={(current.nice_to_have ?? []).join('\n')}
                onChange={(e) =>
                  onChange({
                    ...advanced,
                    nice_to_have: e.target.value.split('\n').filter(Boolean),
                  })
                }
              />
            </Field>
            <Field label="Resume deadline">
              <Input
                value={current.resume_submission?.deadline ?? ''}
                onChange={(e) =>
                  onChange({
                    ...advanced,
                    resume_submission: {
                      channel: draft.resume_channel,
                      value: draft.resume_value,
                      instructions: current.resume_submission?.instructions ?? '',
                      deadline: e.target.value,
                    },
                  })
                }
              />
            </Field>
          </>
        )}
        <Field label="Do not say" hint="One item per line.">
          <Textarea
            value={(current.do_not_say ?? []).join('\n')}
            onChange={(e) =>
              onChange({ ...advanced, do_not_say: e.target.value.split('\n').filter(Boolean) })
            }
          />
        </Field>
        <div className="inline-grid">
          <Field label="Agent name">
            <Input
              value={current.agent_persona?.name ?? 'Mira'}
              onChange={(e) =>
                onChange({
                  ...advanced,
                  agent_persona: {
                    name: e.target.value,
                    tone: current.agent_persona?.tone ?? 'friendly',
                  },
                })
              }
            />
          </Field>
          <Field label="Tone">
            <Select
              value={current.agent_persona?.tone ?? 'friendly'}
              onChange={(e) =>
                onChange({
                  ...advanced,
                  agent_persona: {
                    name: current.agent_persona?.name ?? 'Mira',
                    tone: e.target.value as Campaign['agent_persona']['tone'],
                  },
                })
              }
            >
              {['friendly', 'formal', 'energetic'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </Field>
        </div>
        {draft.languages.map((lang) => (
          <Field key={lang} label={`${languageNames[lang]} voice`}>
            <Select
              value={current.voice?.[lang] ?? 'Shivani'}
              onChange={(e) =>
                onChange({
                  ...advanced,
                  voice: { ...current.voice, [lang]: e.target.value as (typeof voices)[number] },
                })
              }
            >
              {voices.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </Field>
        ))}
        {text('callback_number_or_contact', 'Callback contact')}
        <div className="inline-grid">
          {(['max_attempts', 'concurrency'] as const).map((key) => (
            <Field
              key={key}
              label={key === 'max_attempts' ? 'Maximum attempts' : 'Concurrent calls'}
            >
              <Input
                type="number"
                min="1"
                max={key === 'max_attempts' ? 2 : 10}
                value={current.schedule?.[key] ?? 2}
                onChange={(e) =>
                  onChange({
                    ...advanced,
                    schedule: {
                      ...campaignSchema.parse({
                        ...{
                          name: 'Advanced defaults',
                          type: 'sales',
                          company_name: 'Defaults',
                          product_name: 'Defaults',
                        },
                      }).schedule,
                      ...current.schedule,
                      [key]: Number(e.target.value),
                    },
                  })
                }
              />
            </Field>
          ))}
        </div>
        <p className="helper">
          AI disclosure and recording-off settings always apply. If the end time is earlier,
          the calling window continues after midnight.
        </p>
      </div>
    </Disclosure>
  );
}
