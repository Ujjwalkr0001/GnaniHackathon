import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Headphones,
  LoaderCircle,
  Phone,
  PhoneCall,
  Plus,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';
import { getWorkflow, type WorkflowId } from '../workflows.js';
import { useApp } from '../App.js';
import { api } from '../api.js';
import {
  query,
  readLocal,
  writeLocal,
  useData,
  type CampaignRow,
  type CallRow,
  type ContactRow,
  type ResultRow,
} from '../data.js';
import {
  newMinimalDraft,
  expandToFullConfig,
  campaignDraftMinimalSchema,
  screeningPresets,
  type CampaignDraftMinimal,
} from '../../../../packages/shared/src/minimal.js';
import {
  defaultCampaign,
  voices,
  type Campaign,
  type Contact,
} from '../../../../packages/shared/src/index.js';
import {
  Button,
  Card,
  Chip,
  Disclosure,
  Field,
  Input,
  Select,
  SegmentedControl,
  TagInput,
  Textarea,
  StatusBadge,
} from '../ui/index.js';
import { LanguageField } from './Wizard.js';
import AgentPreview from '../components/AgentPreview.js';
import {
  BrowserTest,
  LeadCard,
  PhoneTranscript,
  TechnicalDetails,
  useLive,
} from '../components/Conversation.js';
interface AgentDraft {
  company: string;
  title: string;
  details: string;
  location: string;
  workMode: Campaign['work_mode'];
  requirements: string[];
  selected: string[];
  custom: string;
  languages: Campaign['languages'];
  voice: string;
  facts: string;
  resume: string;
  start: string;
  end: string;
}
const key = (workflow: string, email: string) =>
  `elevate-agent-v3-${encodeURIComponent(email)}-${workflow}`;
export default function Studio() {
  const { workflow } = useParams();
  return <StudioForm key={workflow} workflow={getWorkflow(workflow).id} />;
}
function StudioForm({ workflow }: { workflow: WorkflowId }) {
  const w = getWorkflow(workflow),
    hr = w.id === 'hr',
    { providers, user, notify } = useApp();
  const [draft, setDraft] = useState<AgentDraft>(() =>
    readLocal(key(workflow, user.email), {
      company: '',
      title: '',
      details: '',
      location: '',
      workMode: 'hybrid',
      requirements: [],
      selected: w.questions.map((q) => q[0]),
      custom: '',
      languages: ['en-IN', 'hi-IN'],
      voice: 'Shivani',
      facts: '',
      resume: '',
      start: '10:00',
      end: '19:00',
    }),
  );
  const [step, setStep] = useState(0),
    [name, setName] = useState(''),
    [phone, setPhone] = useState(''),
    [consent, setConsent] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<CampaignRow>(),
    [queued, setQueued] = useState(false),
    [browser, setBrowser] = useState(false);
  const lock = useRef(false);
  const [autosaved, setAutosaved] = useState(true);
  const results = useData<ResultRow[]>('/results', !!saved),
    calls = useData<CallRow[]>('/calls', !!saved),
    contacts = useData<ContactRow[]>('/contacts', !!saved),
    settings = useData<{ kill_switch: boolean }>('/settings');
  const live = useLive();
  useEffect(() => {
    setAutosaved(writeLocal(key(workflow, user.email), draft));
  }, [draft, workflow, user.email]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);
  const set = <K extends keyof AgentDraft>(field: K, value: AgentDraft[K]) => {
    setError('');
    setDraft((old) => ({ ...old, [field]: value }));
  };
  const minimal = (): CampaignDraftMinimal => ({
    ...newMinimalDraft(hr ? 'hr' : 'sales'),
    company_name: draft.company,
    job_title: draft.title,
    offering: draft.details,
    location: draft.location,
    work_mode: draft.workMode ?? 'hybrid',
    requirements: hr ? draft.requirements : [],
    languages: draft.languages,
    start: draft.start,
    end: draft.end,
    consent,
    resume_channel: 'email',
    resume_value: draft.resume,
    screening: hr
      ? (draft.selected.filter((k) => k in screeningPresets) as CampaignDraftMinimal['screening'])
      : [],
    custom_questions: hr
      ? draft.custom
          .split('\n')
          .filter((q) => q.trim())
          .map((question, i) => ({
            question: question.trim(),
            field_key: `custom_${i + 1}`,
            required: false,
            must_have: false,
            expected_answer_hint: '',
          }))
      : [],
  });
  const friendlyError = (e: unknown) =>
    e instanceof z.ZodError
      ? (e.issues[0]?.message ?? 'Please check the details.')
      : e instanceof Error
        ? e.message
        : 'Please try again.';
  const validate = () => {
    try {
      campaignDraftMinimalSchema.parse(minimal());
      setError('');
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    }
  };
  async function persist(rows: Contact[]) {
    const advanced: Partial<Campaign> = {
      name: `${w.name} · ${draft.company}${hr ? ' · ' + draft.title : ''}`.slice(0, 120),
      schedule: { ...defaultCampaign(hr ? 'hr' : 'sales').schedule, max_attempts: 1 },
      ...(draft.facts
        ? {
            fact_sheet: [
              draft.company,
              draft.title,
              draft.details,
              draft.location,
              ...draft.requirements,
              draft.facts,
            ]
              .filter(Boolean)
              .join('\n'),
          }
        : {}),
    };
    if (hr && draft.details) advanced.role_summary = draft.details;
    if (!hr) {
      advanced.qualification_questions = [
        ...w.questions
          .filter((q) => draft.selected.includes(q[0]))
          .map(([field_key, question]) => ({
            field_key,
            question,
            required: false,
            must_have: false,
            expected_answer_hint: '',
          })),
        ...draft.custom
          .split('\n')
          .filter((q) => q.trim())
          .map((question, i) => ({
            question: question.trim(),
            field_key: `custom_${i + 1}`,
            required: false,
            must_have: false,
            expected_answer_hint: '',
          })),
      ];
    }
    const full = expandToFullConfig(
      { ...minimal(), goal: w.id === 'appointments' ? 'schedule callback' : 'collect interest' },
      { contacts: rows, advanced, voice: draft.voice },
    );
    const row = await api<CampaignRow>(
      saved && !queued ? `/campaigns/${saved.id}` : '/campaigns',
      saved && !queued ? 'PUT' : 'POST',
      full,
    );
    setSaved(row);
    if (rows.length) {
      const report = await api<{ status: string }[]>(`/campaigns/${row.id}/contacts`, 'POST', rows);
      if (report.some((r) => !['valid', 'duplicate'].includes(r.status)))
        throw Error('This number could not be added. Check do-not-call restrictions.');
    }
    await query.invalidateQueries({ queryKey: ['/campaigns'] });
    return row;
  }
  async function place(browserOnly = false) {
    if (lock.current) return;
    if (!validate()) {
      setStep(0);
      return;
    }
    if (!browserOnly && !consent) {
      setError('Confirm consent before starting a call.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      let rows: Contact[] = [];
      if (!browserOnly) {
        const parsed = parsePhoneNumberFromString(phone.trim());
        if (!phone.trim().startsWith('+') || !parsed?.isValid())
          throw Error(
            'Enter a valid phone number with country code, for example +91 followed by the number.',
          );
        rows = [
          {
            phone: parsed.number,
            first_name: name.trim(),
            candidate_name: name.trim(),
            current_role: '',
            source: w.name,
            sample: false,
          },
        ];
        const check = await api<{ status: string }[]>('/contacts/validate', 'POST', rows);
        if (check[0]?.status !== 'valid')
          throw Error(
            check[0]?.status === 'suppressed'
              ? 'This number is on your do-not-call list.'
              : 'Check this phone number and try again.',
          );
      }
      const row = await persist(rows);
      if (browserOnly) {
        setBrowser(true);
        return;
      }
      await api(`/campaigns/${row.id}/launch`, 'POST');
      setQueued(true);
      setStep(2);
      notify(
        providers?.simulation
          ? 'Test call queued. Calling-hour and consent checks still apply.'
          : outsideHours
            ? `Live call scheduled for ${draft.start}–${draft.end} IST.`
            : 'Live call queued. Your calling rules still apply.',
      );
      for (const path of ['/campaigns', '/contacts', '/calls'])
        void query.invalidateQueries({ queryKey: [path] });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  const ownResults = (results.data ?? []).filter((r) => r.data.campaign_id === saved?.id),
    result = ownResults[0],
    ownCalls = (calls.data ?? []).filter((c) => c.data.campaign_id === saved?.id),
    call = ownCalls[0],
    contact = (contacts.data ?? []).find((c) => c.data.campaign_id === saved?.id),
    hasProviderGap = providers ? !providers.simulation && !providers.live_ready : false,
    pause = settings.data?.kill_switch,
    currentIst = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
    outsideHours = currentIst < draft.start || currentIst >= draft.end;
  const reset = () => {
    setQueued(false);
    setSaved(undefined);
    setStep(1);
    setConsent(false);
  };
  return (
    <div className="studio-page">
      <Link to="/workspace" className="studio-back">
        <ArrowLeft size={15} /> All conversations
      </Link>
      <div className="studio-heading">
        <div className={`solution-icon tone-${w.color}`}>
          <w.icon size={25} />
        </div>
        <div>
          <span className="eyebrow">{w.name.toUpperCase()} AGENT</span>
          <h1>{hr ? 'Your next great hire starts here.' : w.short}</h1>
        </div>
        <Chip>
          {saved
            ? 'Saved to your workspace'
            : autosaved
              ? 'Draft · saved on this device'
              : 'Draft · keep this page open'}
        </Chip>
      </div>
      <div className="studio-steps" aria-label="Agent setup">
        {['Agent setup', 'Place a call', 'Conversation results'].map((label, i) => (
          <button
            key={label}
            className={step === i ? 'active' : ''}
            aria-current={step === i ? 'step' : undefined}
            disabled={busy || (i === 2 && !saved)}
            onClick={() => {
              if (i === 0 || validate()) setStep(i);
            }}
          >
            <span>{i < step ? <Check size={14} /> : i + 1}</span>
            {label}
            {i < 2 && <ChevronRight size={14} />}
          </button>
        ))}
      </div>
      {step === 0 ? (
        <div className="studio-layout">
          <form
            className="studio-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (validate()) setStep(1);
            }}
          >
            <Card className="studio-card">
              <div className="card-heading">
                <span className="mint-icon">
                  <FileText size={18} />
                </span>
                <div>
                  <h2>A little context goes a long way.</h2>
                  <p>Your agent will only share the information you provide.</p>
                </div>
              </div>
              <div className="studio-fields">
                <Field label="Company name">
                  <Input
                    value={draft.company}
                    onChange={(e) => set('company', e.target.value)}
                    placeholder="Your company"
                  />
                </Field>
                {hr && (
                  <div className="inline-grid">
                    <Field label="Job title">
                      <Input
                        value={draft.title}
                        onChange={(e) => set('title', e.target.value)}
                        placeholder="For example, Frontend engineer"
                      />
                    </Field>
                    <div>
                      <Field label="Job location">
                        <Input
                          value={draft.location}
                          onChange={(e) => set('location', e.target.value)}
                          placeholder="For example, Bengaluru"
                        />
                      </Field>
                      <div className="work-mode-control">
                        <span className="helper">Work mode</span>
                        <SegmentedControl
                          label="Work mode"
                          value={draft.workMode ?? 'hybrid'}
                          options={['onsite', 'hybrid', 'remote'].map((value) => ({
                            value,
                            label: value[0].toUpperCase() + value.slice(1),
                          }))}
                          onChange={(v) => set('workMode', v as Campaign['work_mode'])}
                        />
                      </div>
                    </div>
                  </div>
                )}
                {hr && (
                  <Field
                    label="Must-have requirements"
                    hint="Checked first, one at a time. A confirmed mismatch ends the screening politely."
                  >
                    <TagInput
                      value={draft.requirements}
                      onChange={(v) => set('requirements', v)}
                      placeholder="For example, 2+ years of React"
                    />
                  </Field>
                )}
                <Field label={w.detailLabel}>
                  <Textarea
                    value={draft.details}
                    onChange={(e) => set('details', e.target.value)}
                    placeholder={w.placeholder}
                    rows={3}
                  />
                </Field>
                <LanguageField value={draft.languages} onChange={(v) => set('languages', v)} />
              </div>
            </Card>
            <Card className="studio-card">
              <div className="card-heading">
                <span className="mint-icon">
                  <Headphones size={18} />
                </span>
                <div>
                  <h2>What should your agent ask?</h2>
                  <p>Choose the questions that matter. Add your own if you like.</p>
                </div>
              </div>
              <div className="question-options">
                {w.questions.map(([id, question]) => (
                  <label
                    key={id}
                    className={`question-option ${draft.selected.includes(id) ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={draft.selected.includes(id)}
                      onChange={() =>
                        set(
                          'selected',
                          draft.selected.includes(id)
                            ? draft.selected.filter((k) => k !== id)
                            : [...draft.selected, id],
                        )
                      }
                    />
                    <span>{question}</span>
                  </label>
                ))}
              </div>
              <Disclosure title="Add your own questions">
                <Field
                  label="Additional questions"
                  hint={
                    hr
                      ? 'One per line. Keep questions job-related; protected personal attributes are not allowed.'
                      : 'One question per line.'
                  }
                >
                  <Textarea
                    value={draft.custom}
                    onChange={(e) => set('custom', e.target.value)}
                    rows={3}
                    placeholder={
                      hr
                        ? 'What recent project are you most proud of?'
                        : 'Is there anything else you would like our team to know?'
                    }
                  />
                </Field>
              </Disclosure>
            </Card>
            <Disclosure title="Voice, approved answers & more">
              <div className="studio-fields">
                <Field label="Agent voice">
                  <Select value={draft.voice} onChange={(e) => set('voice', e.target.value)}>
                    {voices.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="More approved information"
                  hint="FAQs, policies, prices or answers. Leave unknown facts out."
                >
                  <Textarea
                    value={draft.facts}
                    onChange={(e) => set('facts', e.target.value)}
                    rows={3}
                  />
                </Field>
                {hr && (
                  <Field label="Resume submission email (optional)">
                    <Input
                      type="email"
                      value={draft.resume}
                      onChange={(e) => set('resume', e.target.value)}
                      placeholder="careers@your-company.com"
                    />
                  </Field>
                )}
              </div>
            </Disclosure>
            {error && (
              <p className="field-error studio-error" role="alert">
                {error}
              </p>
            )}
            <div className="studio-form-actions">
              <span>
                <ShieldCheck size={15} /> AI introduction is always on
              </span>
              <Button kind="primary" type="submit">
                Continue to call <ArrowRight size={17} />
              </Button>
            </div>
          </form>
          <div className="studio-preview">
            <AgentPreview draft={minimal()} voice={draft.voice} />
            <div className="studio-preview-note">
              <Sparkles size={18} />
              <p>
                {hr
                  ? 'Screen for the role. Listen to the person. Your team always makes the hiring decision.'
                  : 'Your voice agent captures the details. Your team takes the next step.'}
              </p>
            </div>
            <Link to="/settings#connections" className="text-link">
              Manage your connections <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>
      ) : step === 1 ? (
        <div className="call-workspace">
          <Card className="call-portal">
            <div className="call-portal-icon">
              <PhoneCall size={29} />
            </div>
            <span className="eyebrow">ONE NUMBER. ONE GOOD CONVERSATION.</span>
            <h2>{hr ? 'Meet your next candidate.' : 'Let’s get talking.'}</h2>
            <p>Paste a number. Your agent will take it from here.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void place();
              }}
            >
              <div className="studio-fields">
                <Field label={hr ? 'Candidate name (optional)' : 'Contact name (optional)'}>
                  <Input
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Who are we calling?"
                  />
                </Field>
                <div className="field">
                  <label htmlFor="call-phone">Phone number</label>
                  <div className="phone-number-wrap">
                    <Phone size={19} />
                    <Input
                      id="call-phone"
                      type="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        setError('');
                      }}
                      placeholder="+91 98765 43210"
                      aria-describedby="call-phone-hint"
                    />
                  </div>
                  <p id="call-phone-hint" className="helper">
                    Include the country code. The number is checked before every call.
                  </p>
                </div>
                <Disclosure title={`Calling hours · ${draft.start}–${draft.end} IST`}>
                  <div className="inline-grid">
                    <Field label="Calling starts">
                      <Input
                        type="time"
                        value={draft.start}
                        onChange={(e) => set('start', e.target.value)}
                      />
                    </Field>
                    <Field label="Calling ends">
                      <Input
                        type="time"
                        value={draft.end}
                        onChange={(e) => set('end', e.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="helper">
                    If the end time is earlier, the window continues after midnight. Call only at times the person agreed to.
                  </p>
                </Disclosure>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    I confirm this person agreed to be called and I follow telemarketing rules.
                  </span>
                </label>
              </div>
              {error && (
                <p className="field-error studio-error" role="alert">
                  {error}
                </p>
              )}
              {pause && (
                <p className="field-error" role="alert">
                  New calls are paused in workspace settings.
                </p>
              )}
              <Button
                kind="primary"
                type="submit"
                disabled={
                  busy || !consent || !providers || hasProviderGap || pause || user.role !== 'admin'
                }
              >
                {busy ? <LoaderCircle size={17} className="spin" /> : <PhoneCall size={17} />}{' '}
                {busy
                  ? 'Preparing your call…'
                  : providers?.simulation
                    ? 'Queue test call'
                    : outsideHours
                      ? 'Schedule live call'
                      : 'Place live call'}
              </Button>
              <div className="call-provider-note">
                <ShieldCheck size={14} />
                {providers?.simulation
                  ? 'Simulation mode · No real phone call will be placed.'
                  : outsideHours
                    ? `It is ${currentIst} IST. The call will wait for ${draft.start}–${draft.end} IST.`
                    : 'Calls are placed through your configured Twilio account.'}
              </div>
            </form>
            <div className="browser-test-option">
              <span>Try your agent here. No phone number or calling consent is needed.</span>
              <Button
                type="button"
                disabled={busy || !providers || pause || user.role !== 'admin'}
                onClick={() => void place(true)}
              >
                <Headphones size={16} />
                Test in browser
              </Button>
            </div>
          </Card>
          <aside className="call-context">
            <Card className="studio-card">
              <span className="eyebrow">YOUR AGENT AT A GLANCE</span>
              <div className="agent-context-title">
                <span className={`solution-icon tone-${w.color}`}>
                  <w.icon size={22} />
                </span>
                <div>
                  <h3>{w.name}</h3>
                  <p>{draft.company}</p>
                </div>
              </div>
              {hr && <p className="role-preview">{draft.title}</p>}
              <div className="call-context-line">
                <AudioLines size={16} />
                {draft.voice} ·{' '}
                {draft.languages.map((l) => l.split('-')[0].toUpperCase()).join(' + ')}
              </div>
              <div className="call-context-line">
                <Check size={16} />
                {draft.selected.length +
                  (hr ? draft.requirements.length : 0) +
                  draft.custom.split('\n').filter(Boolean).length}{' '}
                questions configured
              </div>
              <div className="call-context-line">
                <Clock3 size={16} />
                {draft.start}–{draft.end} IST
              </div>
              {hr && <p className="helper">Introduction → must-have requirements → role details → your selected questions → candidate questions → next steps.</p>}
              <Button kind="ghost" onClick={() => setStep(0)}>
                Edit agent <ArrowUpRight size={15} />
              </Button>
            </Card>
            <div className="call-explanation">
              <h3>
                {providers?.simulation
                  ? 'You’re in the practice room.'
                  : 'A clear next step after every call.'}
              </h3>
              <p>
                {providers?.simulation
                  ? 'The test queue respects your calling hours. Use Test in browser for an immediate scripted conversation. Connect live providers before calling real numbers.'
                  : 'The conversation, summary and captured answers appear here after the call. Calls outside your hours wait until the next window.'}
              </p>
              <Link to="/settings#connections" className="text-link">
                {providers?.simulation ? 'Set up live calling' : 'Check connections'}
                <ArrowUpRight size={15} />
              </Link>
            </div>
            {hasProviderGap && (
              <p className="field-error">
                Live calling needs a provider or public HTTPS callback URL. Open connections to
                review the setup.
              </p>
            )}
          </aside>
        </div>
      ) : (
        <div className="studio-results">
          <div className="section-label">
            <div>
              <h2>Every conversation has a next step.</h2>
              <p>Your transcript, summary and captured answers stay together.</p>
            </div>
            <Button onClick={reset}>
              <Plus size={16} />
              Call another person
            </Button>
          </div>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {result ? (
            <>
              <div className="conversation-grid">
                <PhoneTranscript turns={result.data.transcript} languages={result.data.languages} />
                <LeadCard
                  result={result.data}
                  fields={result.data.extracted_fields}
                  name={contact?.data.first_name || 'Browser test call'}
                  phone={contact?.data.phone}
                  source={w.name}
                  languages={result.data.languages}
                />
              </div>
              <TechnicalDetails result={result.data} />
            </>
          ) : (
            <Card className="call-waiting">
              <span className="call-portal-icon">
                <PhoneCall size={29} />
              </span>
              <h2>
                {call?.data.status === 'failed'
                  ? 'The call could not connect.'
                  : call?.data.status === 'in-progress'
                    ? 'Your conversation is underway.'
                    : contact?.data.status === 'scheduled'
                      ? 'Your call is scheduled.'
                    : queued
                      ? 'Your call is in the queue.'
                      : 'Ready for your first conversation.'}
              </h2>
              <p>
                {contact?.data.next_attempt_at
                  ? `Scheduled for ${new Date(contact.data.next_attempt_at).toLocaleString('en-IN', {
                      timeZone: 'Asia/Kolkata',
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })} IST. ${contact.data.blocked_reason ?? ''}`
                  : contact?.data.blocked_reason ??
                  (queued
                    ? `Calls follow ${draft.start}–${draft.end} IST and your workspace calling rules. The summary appears once a call completes.`
                    : 'Place a phone call or try a browser test to see the result here.')}
              </p>
              {call && <StatusBadge status={call.data.status} />}
              <div className="call-waiting-actions">
                <Button
                  onClick={() => {
                    for (const path of ['/results', '/calls', '/contacts'])
                      void query.invalidateQueries({ queryKey: [path] });
                  }}
                >
                  Refresh status
                </Button>
                {saved && (
                  <Link className="btn btn-secondary" to={`/campaigns/${saved.id}`}>
                    View campaign <ArrowUpRight size={15} />
                  </Link>
                )}
              </div>
            </Card>
          )}
          {results.isError && (
            <p role="alert" className="field-error">
              Results could not be loaded. Refresh the status to try again.
            </p>
          )}
          {live.error && queued && (
            <p role="status" className="helper">
              {live.error}
            </p>
          )}
        </div>
      )}
      {browser && saved && (
        <BrowserTest
          campaign={saved}
          onClose={() => {
            setBrowser(false);
            setStep(2);
            void query.invalidateQueries({ queryKey: ['/results'] });
          }}
        />
      )}
    </div>
  );
}
