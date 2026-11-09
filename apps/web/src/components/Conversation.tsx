import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Check, Headphones, Mic, Square } from 'lucide-react';
import type { CallResult, Turn } from '../../../../packages/shared/src/index.js';
import { BrowserAudio } from '../browser-audio.js';
import { wsUrl } from '../api.js';
import { useApp } from '../App.js';
import {
  change,
  friendly,
  getContact,
  maskPhone,
  refreshResults,
  useData,
  type CampaignRow,
  type ContactRow,
  type DeliveryRow,
  type ResultRow,
} from '../data.js';
import { languageNames, stageNames } from '../strings.js';
import { Button, Card, Chip, Disclosure, Drawer, Input, StatusBadge } from '../ui/index.js';
import RequirementMatch from './RequirementMatch.js';
export interface LiveEvent {
  call_id: string;
  type: string;
  data: unknown;
}
export function useLive() {
  const [events, setEvents] = useState<LiveEvent[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let mounted = true,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout>,
      attempts = 0;
    const connect = () => {
      socket = new WebSocket(wsUrl('/ws/monitor'));
      socket.onmessage = (e) => {
        try {
          const item = JSON.parse(e.data);
          if (item.call_id) setEvents((old) => [...old.slice(-500), item]);
          if (item.type === 'result') refreshResults();
        } catch {
          setError('A live update could not be read.');
        }
      };
      socket.onopen = () => setError('');
      socket.onerror = () => setError('Live updates are reconnecting.');
      socket.onclose = () => {
        if (mounted && ++attempts < 4) timer = setTimeout(connect, 1500);
        else if (mounted) setError('Live updates paused. Refresh to reconnect.');
      };
    };
    connect();
    return () => {
      mounted = false;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);
  return { events, error };
}
function liveState(events: LiveEvent[], id: string) {
  const own = events.filter((e) => e.call_id === id);
  return {
    turns: own.filter((e) => e.type === 'transcript').map((e) => e.data as Turn),
    fields: (own.filter((e) => e.type === 'fields').at(-1)?.data ?? {}) as Record<
      string,
      string | number | boolean
    >,
    stage: own.filter((e) => e.type === 'stage').at(-1)?.data as string | undefined,
    result: own.filter((e) => e.type === 'result').at(-1)?.data as CallResult | undefined,
    tools: own
      .filter((e) => e.type === 'tool')
      .map((e) => e.data as CallResult['tool_log'][number]),
    providers: own.filter((e) => e.type === 'provider').map((e) => e.data),
    latency: own.filter((e) => e.type === 'latency').map((e) => e.data),
  };
}
export function PhoneTranscript({
  turns,
  languages = [],
  tools = [],
  live = false,
}: {
  turns: Turn[];
  languages?: string[];
  tools?: CallResult['tool_log'];
  live?: boolean;
}) {
  const eventChips = tools
    .filter((t) => !('error' in (typeof t.result === 'object' && t.result ? t.result : {})))
    .filter((t) => ['schedule_callback', 'mark_do_not_call', 'mark_wrong_number'].includes(t.name));
  return (
    <section aria-label="Transcript">
      <div className="conversation-context">
        <span>{live ? 'Live conversation' : 'Transcript'}</span>
        <span>{languages.map((l) => languageNames[l] ?? l).join(' + ')}</span>
      </div>
      <div
        className="phone-transcript"
        role="log"
        tabIndex={0}
        aria-label={live ? 'Live transcript' : 'Conversation transcript'}
        aria-live={live ? 'polite' : 'off'}
        aria-relevant="additions"
      >
        {!turns.length && (
          <p className="helper">
            {live
              ? 'The conversation will appear here.'
              : 'No transcript was recorded for this call.'}
          </p>
        )}
        {turns.map((turn, i) => (
          <article className={`message ${turn.role}`} key={`${turn.at}-${i}`}>
            <small>
              {turn.role === 'agent' ? 'AI assistant' : 'Contact'} ·{' '}
              {new Date(turn.at).toLocaleTimeString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </small>
            <p>{turn.text}</p>
          </article>
        ))}
        {eventChips.map((tool, i) => (
          <div className="inline-event" key={i}>
            <Chip>
              {tool.name === 'schedule_callback'
                ? 'Callback requested'
                : tool.name === 'mark_do_not_call'
                  ? 'Added to do-not-call'
                  : 'Wrong number noted'}
            </Chip>
          </div>
        ))}
      </div>
    </section>
  );
}
export function LeadCard({
  result,
  fields,
  name,
  phone,
  source,
  languages = [],
  deliveries = [],
  live = false,
}: {
  result?: CallResult;
  fields: Record<string, string | number | boolean>;
  name: string;
  phone?: string;
  source?: string;
  languages?: string[];
  deliveries?: DeliveryRow[];
  live?: boolean;
}) {
  const { notify } = useApp();
  return (
    <Card className="lead-card">
      <div className="row between">
        <span className="eyebrow">{result?.eligibility ? 'Candidate' : 'Conversation result'}</span>
        {result ? (
          <StatusBadge status={result.outcome} />
        ) : (
          <Chip>{live ? 'In progress' : 'Call result'}</Chip>
        )}
      </div>
      <h2>{name}</h2>
      <p className="identity">
        {phone ? maskPhone(phone) : 'No phone number'}
        {source ? ` · ${source}` : ''}
      </p>
      <div className="chips" style={{ marginTop: 16 }}>
        {languages.map((l) => (
          <Chip key={l}>{languageNames[l] ?? l}</Chip>
        ))}
        {result?.sample && <Chip>Sample</Chip>}
        {result?.simulation && <Chip>Simulation</Chip>}
      </div>
      {result && (
        <p className="summary">
          {result.summary
            .replace(/\[SIMULATION\]\s*/, '')
            .replace(/WRAP_UP/g, 'the closing stage')
            .replace(/DISCOVERY_SCREENING/g, 'screening')}
        </p>
      )}
      {result?.recommendation && result.eligibility && (
        <div className="stack-small" style={{ marginTop: 16 }}>
          <strong>Recruiter notes</strong>
          <p>{result.recommendation}</p>
        </div>
      )}
      <dl className="label-values">
        {Object.entries(fields).map(([key, value]) => (
          <div key={key}>
            <dt>{friendly(key)}</dt>
            <dd>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}</dd>
          </div>
        ))}
      </dl>
      {!Object.keys(fields).length && (
        <p className="helper" style={{ margin: '24px 0' }}>
          {live ? 'Details will fill in as the call continues.' : 'No details were captured.'}
        </p>
      )}
      {result?.eligibility && (
        <div className="stack-small" style={{ marginBottom: 24 }}>
          <RequirementMatch eligibility={result.eligibility} />
          <Chip>
            {(
              {
                MEETS_ALL_MUST_HAVES: 'Meets all must-haves',
                PARTIAL: 'Partial match',
                DOES_NOT_MEET: 'Requirements not met',
                UNCLEAR: 'Match unclear',
              } as Record<string, string>
            )[result.eligibility.value] ?? 'Match unclear'}
          </Chip>
          <p className="helper">Advisory screening. Your team makes the hiring decision.</p>
        </div>
      )}
      <div className="chips" aria-label="Delivery status">
        {result && (
          <Chip tone="positive">
            <Check size={12} />
            Saved internally
          </Chip>
        )}
        {deliveries.map((d) => (
          <span className="row" key={d.id}>
            <Chip
              tone={
                d.data.status === 'delivered'
                  ? 'positive'
                  : d.data.status === 'dead_letter'
                    ? 'negative'
                    : 'amber'
              }
            >
              {d.data.status === 'delivered'
                ? 'Webhook sent'
                : d.data.status === 'dead_letter'
                  ? 'Delivery failed'
                  : 'Retrying delivery'}
            </Chip>
            {d.data.status !== 'delivered' && (
              <Button
                kind="ghost"
                onClick={() => {
                  void change(`/deliveries/${d.id}/retry`)
                    .then(() => notify('Delivery queued again.'))
                    .catch((e) => notify(e.message));
                }}
              >
                Retry
              </Button>
            )}
          </span>
        ))}
      </div>
    </Card>
  );
}
export function TechnicalDetails({
  result,
  live,
}: {
  result?: CallResult;
  live?: ReturnType<typeof liveState>;
}) {
  const timings = result?.latency ?? [];
  const fromFinal = timings.some((l) => l.stt_final_to_audio_ms !== undefined);
  const measured = timings
    .flatMap((l) =>
      (fromFinal ? l.stt_final_to_audio_ms : l.end_of_speech_to_audio_ms) === undefined
        ? [] : [(fromFinal ? l.stt_final_to_audio_ms : l.end_of_speech_to_audio_ms)!],
    )
    .sort((a, b) => a - b);
  const p = (v: number) =>
    measured.length
      ? `${Math.round(measured[Math.max(0, Math.ceil(measured.length * v) - 1)])} ms`
      : 'Not measured';
  return (
    <Disclosure title="Details">
      <div className="technical-details stack">
        <div className="row">
          <Chip>{fromFinal ? 'Transcript to audio' : 'Endpoint to audio'} p50: {p(0.5)}</Chip>
          <Chip>p95: {p(0.95)}</Chip>
        </div>
        <p className="helper">
          Timing runs from the server’s {fromFinal ? 'final transcript' : 'endpointing event'} to its first outgoing audio frame. Phone network delay is excluded. Usage is metered, not billed.{' '}
          {result?.simulation ? 'These observations came from a simulation.' : ''}
        </p>
        {[
          ['Providers', result?.provider_trace ?? live?.providers],
          ['Turn measurements', result?.latency ?? live?.latency],
          ['Usage', result?.usage],
          ['State & tool log', result?.tool_log ?? live?.tools],
        ].map(([label, value]) => (
          <div key={label as string}>
            <h3>{label as string}</h3>
            <pre>{JSON.stringify(value ?? [], null, 2)}</pre>
          </div>
        ))}
        <p className="helper">
          Cost estimate is unavailable per call; provider bills are authoritative.
        </p>
      </div>
    </Disclosure>
  );
}
export function ConversationDrawer({
  row,
  onClose,
  liveId,
}: {
  row?: ResultRow;
  onClose: () => void;
  liveId?: string;
}) {
  const live = useLive(),
    contacts = useData<ContactRow[]>('/contacts'),
    deliveries = useData<DeliveryRow[]>('/deliveries'),
    state = liveState(live.events, liveId ?? row?.data.call_id ?? ''),
    result = state.result ?? row?.data;
  const contact = row ? getContact(row, contacts.data ?? []) : undefined;
  return (
    <Drawer title={liveId ? 'Live conversation' : 'Conversation'} wide onClose={onClose}>
      {live.error && (
        <p className="field-error" role="status">
          {live.error}
        </p>
      )}
      {liveId && (
        <p className="helper" style={{ marginBottom: 16 }}>
          {stageNames[state.stage ?? ''] ?? 'Connecting'}
        </p>
      )}
      <div className="conversation-grid">
        <PhoneTranscript
          turns={state.turns.length ? state.turns : (result?.transcript ?? [])}
          languages={result?.languages}
          tools={result?.tool_log ?? state.tools}
          live={!!liveId}
        />
        <LeadCard
          result={result}
          fields={
            Object.keys(state.fields).length ? state.fields : (result?.extracted_fields ?? {})
          }
          name={
            contact?.data.first_name ||
            contact?.data.candidate_name ||
            (result?.contact_id ? 'Contact' : 'Browser test call')
          }
          phone={contact?.data.phone}
          source={contact?.data.source}
          languages={result?.languages}
          deliveries={deliveries.data?.filter((d) => d.data.result_id === row?.id)}
          live={!!liveId}
        />
      </div>
      <TechnicalDetails result={result} live={state} />
    </Drawer>
  );
}
export function BrowserTest({ campaign, onClose }: { campaign: CampaignRow; onClose: () => void }) {
  const { providers } = useApp(),
    live = useLive(),
    [status, setStatus] = useState('Ready when you are.'),
    [id, setId] = useState(''),
    [started, setStarted] = useState(false),
    [text, setText] = useState('');
  const client = useRef<BrowserAudio | null>(null);
  const state = useMemo(() => liveState(live.events, id), [live.events, id]);
  useEffect(() => {
    if (status === 'Call ended') {
      refreshResults();
    }
  }, [status]);
  useEffect(() => () => {
    const audio = client.current;
    client.current = null;
    audio?.end();
  }, []);
  const failed = /failed|could not|closed before|denied|permission/i.test(status);
  return (
    <Drawer title="Browser test call" wide onClose={onClose}>
      <div className={`browser-session ${started && id ? 'active' : ''}`}>
        <div className="browser-session-main">
          <span className="browser-session-icon">
            <Headphones size={25} />
          </span>
          <div>
            <span className="eyebrow">
              {providers?.simulation ? 'SCRIPTED PRACTICE' : 'LIVE VOICE TEST'}
            </span>
            <h3>{started && id ? 'Conversation in progress' : 'Talk to your agent'}</h3>
            <p>
              {providers?.simulation
                ? 'Try the conversation with typed replies. No microphone or phone number is used.'
                : 'Use your microphone to speak with the agent. No phone number is dialed.'}
            </p>
          </div>
        </div>
        <div className="browser-session-controls">
          <span
            className={`browser-connection ${failed ? 'error' : started && id ? 'connected' : ''}`}
            role="status"
          >
            <span className="browser-connection-dot" /> {status}
          </span>
          {!started ? (
            <Button
              kind="primary"
              disabled={!providers}
              onClick={() => {
                setId('');
                setStatus('Connecting to your agent…');
                setStarted(true);
                const audio = new BrowserAudio(
                  (next) => {
                    if (client.current !== audio) return;
                    setStatus(next);
                    if (next === 'Call ended' || /failed|could not|closed before|denied|permission/i.test(next)) {
                      setStarted(false);
                      client.current = null;
                      audio.end();
                    }
                  },
                  (callId) => {
                    if (client.current === audio) setId(callId);
                  },
                );
                client.current = audio;
                void audio.start(campaign.id, !!providers?.simulation).catch((error) => {
                  if (client.current !== audio) return;
                  const message =
                    error instanceof Error && error.name === 'NotAllowedError'
                      ? 'Microphone access was denied. Allow it in your browser and try again.'
                      : error instanceof Error
                        ? error.message
                        : 'Browser test could not start.';
                  setStatus(message);
                  setStarted(false);
                  audio.end();
                });
              }}
            >
              <Mic size={16} />
              {providers?.simulation ? 'Start practice' : 'Start conversation'}
            </Button>
          ) : (
            <Button
              onClick={() => {
                const audio = client.current;
                client.current = null;
                audio?.end();
                setStarted(false);
                setStatus('Call ended');
              }}
            >
              <Square size={16} />
              End conversation
            </Button>
          )}
        </div>
      </div>
      {failed && (
        <p className="field-error browser-call-error" role="alert">
          {status}
        </p>
      )}
      <div className="browser-conversation-grid">
        <div className="browser-transcript-panel">
          <div className="browser-panel-title">
            <div>
              <span className="eyebrow">YOUR CONVERSATION</span>
              <h3>What you and the agent say</h3>
            </div>
            <AudioLines size={21} />
          </div>
          <PhoneTranscript
            turns={state.turns}
            languages={state.result?.languages ?? campaign.data.languages}
            tools={state.tools}
            live
          />
          {providers?.simulation && started && !!id && (
            <form
              className="simulation-input"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim()) {
                  client.current?.text(text.trim());
                  setText('');
                }
              }}
            >
              <Input
                aria-label="Simulated caller response"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Type your reply to the agent"
              />
              <Button type="submit" disabled={!text.trim()}>
                Send reply
              </Button>
            </form>
          )}
          {live.error && <p className="helper">{live.error}</p>}
        </div>
        {state.result || Object.keys(state.fields).length ? (
          <LeadCard
            result={state.result}
            fields={state.fields}
            name="Browser test call"
            languages={campaign.data.languages}
            live={started}
          />
        ) : (
          <Card className="browser-guidance">
            <span className="eyebrow">{started && id ? 'YOUR PRACTICE SESSION' : 'BEFORE YOU BEGIN'}</span>
            <h3>{started && id ? 'Keep the conversation going' : 'A simple way to try your agent'}</h3>
            <p>
              {started && id
                ? providers?.simulation
                  ? 'Type your reply below the transcript. Your agent will respond here.'
                  : 'Speak naturally into your microphone. Your agent and transcript will update here.'
                : providers?.simulation
                  ? 'Start practice, then type a reply when the agent asks a question.'
                  : 'Allow microphone access, listen to the introduction, and answer naturally.'}
            </p>
            <div><span>01</span> {started && id ? 'Conversation started' : 'Start the conversation'}</div>
            <div><span>02</span> Reply to the agent</div>
            <div><span>03</span> Review the saved result</div>
          </Card>
        )}
      </div>
      <TechnicalDetails result={state.result} live={state} />
    </Drawer>
  );
}
