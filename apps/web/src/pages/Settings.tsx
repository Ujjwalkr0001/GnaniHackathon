import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { voices, type Campaign } from '../../../../packages/shared/src/index.js';
import { useApp } from '../App.js';
import { DEFAULTS_KEY, DRAFT_KEY } from '../config.js';
import {
  change,
  maskPhone,
  readLocal,
  useData,
  writeLocal,
  type DeliveryRow,
  type DestinationRow,
} from '../data.js';
import {
  Button,
  Card,
  Chip,
  Disclosure,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  StatusBadge,
} from '../ui/index.js';
import { LanguageField } from './Wizard.js';
import { VoiceSample } from '../components/AgentPreview.js';
import Connections from '../components/Connections.js';
interface SettingsData {
  retention_days: number;
  kill_switch: boolean;
  global_daily_minutes: number;
  global_daily_stt_seconds?: number;
  global_daily_tts_chars?: number;
  rates: Record<string, number>;
}
export default function Settings() {
  const { providers, user, notify } = useApp(),
    location = useLocation(),
    destinations = useData<DestinationRow[]>('/destinations'),
    deliveries = useData<DeliveryRow[]>('/deliveries'),
    suppression = useData<{ id: string; data: { phone: string } }[]>('/suppression'),
    team = useData<{ id: string; email: string; data: { role: string } }[]>('/team'),
    settings = useData<SettingsData>('/settings');
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [phone, setPhone] = useState(''),
    [retention, setRetention] = useState<number>(),
    [voice, setVoice] = useState(
      () => readLocal(DEFAULTS_KEY, { voice: 'Shivani', languages: ['en-IN', 'hi-IN'] }).voice,
    ),
    [langs, setLangs] = useState<Campaign['languages']>(
      () =>
        readLocal<{ languages: Campaign['languages'] }>(DEFAULTS_KEY, {
          languages: ['en-IN', 'hi-IN'],
        }).languages,
    ),
    [rates, setRates] = useState<Record<string, number>>({}),
    [cap, setCap] = useState<number>();
  const admin = user.role === 'admin';
  useEffect(() => {
    if (location.hash)
      requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
  }, [location.hash]);
  const act = (path: string, method = 'POST', body?: unknown, message = 'Saved.') => {
    void change(path, method, body)
      .then(() => notify(message))
      .catch((e) => notify(e.message));
  };
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>Make yourself at home.</h1>
          <p>Your connections, preferences and calling rules. All together.</p>
        </div>
      </div>
      <Connections />
      <section id="delivery" className="settings-section">
        <h2>Delivery</h2>
        <p>
          Every result stays in your workspace. Add a webhook to send qualified outcomes elsewhere.
        </p>
        <Card className="destination-card">
          <div className="row between">
            <div>
              <h3>Internal workspace</h3>
              <p className="helper">Leads and candidates are saved first.</p>
            </div>
            <Chip tone="positive">Always on</Chip>
          </div>
        </Card>
        {destinations.isPending ? (
          <Skeleton lines={1} />
        ) : (
          destinations.data?.map((d) => (
            <Card className="destination-card" key={d.id}>
              <div className="row between">
                <div className="grow">
                  <h3>{d.data.name}</h3>
                  <p className="helper">{d.data.url}</p>
                </div>
                <StatusBadge
                  status={
                    (deliveries.data ?? []).find((r) => r.data.destination_id === d.id)?.data
                      .status ?? 'No deliveries yet'
                  }
                />
              </div>
              {admin && (
                <div className="row" style={{ marginTop: 16 }}>
                  <Button
                    onClick={() =>
                      act(`/destinations/${d.id}/test`, 'POST', undefined, 'Synthetic test sent.')
                    }
                  >
                    Send test
                  </Button>
                  <Button
                    kind="ghost"
                    aria-label={`Remove ${d.data.name}`}
                    onClick={() => {
                      if (confirm('Remove this delivery destination?'))
                        act(`/destinations/${d.id}`, 'DELETE');
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              )}
            </Card>
          ))
        )}
        {destinations.isError && (
          <p className="field-error" role="alert">
            Delivery settings could not be loaded.
          </p>
        )}
        {admin && (
          <Disclosure title="Add a webhook">
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void change('/destinations', 'POST', { name, url, kind: 'webhook', enabled: true })
                  .then(() => {
                    notify('Webhook added. Select it when reviewing a campaign.');
                    setName('');
                    setUrl('');
                  })
                  .catch((e) => notify(e.message));
              }}
            >
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="HTTPS address">
                <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
              </Field>
              <div>
                <Button>Add webhook</Button>
              </div>
            </form>
          </Disclosure>
        )}
        {(deliveries.data ?? []).some((d) => d.data.status !== 'delivered') && (
          <Disclosure title="Deliveries needing attention">
            {deliveries.data
              ?.filter((d) => d.data.status !== 'delivered')
              .map((d) => (
                <div className="setting-row" key={d.id}>
                  <div className="grow">
                    <StatusBadge status={d.data.status} />
                    <small>
                      {d.data.attempts} attempts · {d.data.error ?? 'Waiting to retry'}
                    </small>
                  </div>
                  {admin && (
                    <Button
                      onClick={() =>
                        act(
                          `/deliveries/${d.id}/retry`,
                          'POST',
                          undefined,
                          'Delivery queued again.',
                        )
                      }
                    >
                      Retry
                    </Button>
                  )}
                </div>
              ))}
          </Disclosure>
        )}
      </section>
      <section className="settings-section" id="do-not-call">
        <h2>Do-not-call list</h2>
        <p>These numbers are blocked before every call, including retries.</p>
        {admin && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void change('/suppression', 'POST', { phone })
                .then(() => {
                  setPhone('');
                  notify('Number added to do-not-call.');
                })
                .catch((e) => notify(e.message));
            }}
          >
            <div className="grow">
              <Input
                aria-label="Number to block"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone number with country code"
                required
              />
            </div>
            <Button>Add number</Button>
          </form>
        )}
        {suppression.isError ? (
          <ErrorState
            message="We couldn’t load blocked numbers."
            retry={() => void suppression.refetch()}
          />
        ) : suppression.isPending ? (
          <Skeleton lines={1} />
        ) : suppression.data?.length ? (
          <Disclosure title={`${suppression.data.length} blocked numbers`}>
            {suppression.data.map((s) => (
              <div className="setting-row" key={s.id}>
                <span>{maskPhone(s.data.phone)}</span>
                {admin && (
                  <Button
                    kind="ghost"
                    aria-label="Remove blocked number"
                    onClick={() => {
                      if (
                        confirm(
                          'Allow this number to be considered for calls again? Only remove it with renewed consent.',
                        )
                      )
                        act(`/suppression/${s.id}`, 'DELETE');
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            ))}
          </Disclosure>
        ) : (
          <p className="helper" style={{ marginTop: 16 }}>
            No numbers added.
          </p>
        )}
      </section>
      <section className="settings-section">
        <h2>Voice & language defaults</h2>
        <p>Used for new campaigns on this device. Existing campaigns keep their settings.</p>
        <div className="stack">
          <LanguageField value={langs} onChange={setLangs} />
          <Field label="Default voice">
            <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </Field>
          <div className="row">
            <Button
              onClick={() => {
                if (writeLocal(DEFAULTS_KEY, { voice, languages: langs }))
                  notify('Defaults saved on this device.');
                else notify('Your browser could not save the defaults.');
              }}
            >
              Save defaults
            </Button>
            <VoiceSample voice={voice} language={langs[0]} />
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h2>Team</h2>
        <p>Your workspace members and their access.</p>
        {team.isError ? (
          <ErrorState message="We couldn’t load the team." retry={() => void team.refetch()} />
        ) : team.isPending ? (
          <Skeleton lines={1} />
        ) : (
          team.data?.map((u) => (
            <div className="setting-row" key={u.id}>
              <span className="grow">{u.email}</span>
              <Chip>{u.data.role === 'admin' ? 'Administrator' : 'Read only'}</Chip>
            </div>
          ))
        )}
        <p className="helper" style={{ marginTop: 16 }}>
          Ask your administrator to provision an account or reset a password.
        </p>
      </section>
      <section className="settings-section" id="privacy">
        <h2>Data & privacy</h2>
        <p>
          AI disclosure is always on. Recording is off. The operator is responsible for consent and
          telemarketing obligations.
        </p>
        {settings.isPending && <Skeleton lines={1} />}
        {settings.isError && (
          <ErrorState
            message="We couldn’t load workspace settings."
            retry={() => void settings.refetch()}
          />
        )}
        <div className="stack">
          <Field label="Keep transcripts for (days)">
            <Input
              type="number"
              min="1"
              max="365"
              value={retention ?? settings.data?.retention_days ?? ''}
              onChange={(e) => setRetention(Number(e.target.value))}
              readOnly={!admin}
            />
          </Field>
          {admin && (
            <div>
              <Button
                disabled={!settings.data}
                onClick={() => {
                  if (settings.data)
                    act(
                      '/settings',
                      'PUT',
                      {
                        ...settings.data,
                        retention_days: retention ?? settings.data.retention_days,
                      },
                      'Retention updated.',
                    );
                }}
              >
                Save retention
              </Button>
            </div>
          )}
          <Disclosure title="Calling rules & draft data">
            <p className="text-small">
              Choose calling hours that match each recipient’s consent and preferences, including
              overnight windows when appropriate. Do-not-call and calling-limit checks still apply.
              The app does not scrub national DND registries. HR results are advisory; humans decide.
            </p>
            <p className="text-small">
              Unfinished drafts, including pasted contacts, are saved on this device. They are
              cleared after launch.
            </p>
            <div>
              <Button
                onClick={() => {
                  if (confirm('Clear the unfinished campaign draft on this device?')) {
                    localStorage.removeItem(DRAFT_KEY);
                    for (const key of Object.keys(localStorage).filter((k) =>
                      k.startsWith('elevate-agent-v3-'),
                    ))
                      localStorage.removeItem(key);
                    notify('Local draft cleared.');
                  }
                }}
              >
                Clear local draft
              </Button>
            </div>
          </Disclosure>
        </div>
      </section>
      <section className="settings-section" id="status">
        <h2>Status</h2>
        <p>Provider configuration and workspace limits.</p>
        {providers?.services.map((s) => (
          <div className="setting-row" key={s.name}>
            <span>{s.name}</span>
            <Chip>{s.status}</Chip>
          </div>
        ))}
        <p className="helper" style={{ marginTop: 16 }}>
          Speech: Gnani Prisma + Timbre. Dialogue: {providers?.dialogue ?? 'Loading'}. Configured
          does not mean live-tested.
        </p>
        <Disclosure title="Usage limits & estimates">
          <div className="stack">
            <Field label="Daily call minutes">
              <Input
                type="number"
                min="1"
                value={cap ?? settings.data?.global_daily_minutes ?? ''}
                onChange={(e) => setCap(Number(e.target.value))}
                readOnly={!admin}
              />
            </Field>
            {Object.entries({
              stt_per_minute: 'Speech recognition / minute',
              tts_per_1000_chars: 'Voice / 1,000 characters',
              llm_per_1000_tokens: 'Dialogue / 1,000 tokens',
              telephony_per_minute: 'Telephony / minute',
            }).map(([key, label]) => (
              <Field key={key} label={`${label} · INR`}>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  placeholder="No rate configured"
                  value={rates[key] ?? settings.data?.rates[key] ?? ''}
                  onChange={(e) => setRates((old) => ({ ...old, [key]: Number(e.target.value) }))}
                  readOnly={!admin}
                />
              </Field>
            ))}
            <p className="helper">Operator-supplied rates are estimates, not billed amounts.</p>
            {admin && (
              <Button
                onClick={() => {
                  if (settings.data)
                    act(
                      '/settings',
                      'PUT',
                      {
                        ...settings.data,
                        global_daily_minutes: cap ?? settings.data.global_daily_minutes,
                        rates: { ...settings.data.rates, ...rates },
                      },
                      'Limits and estimate rates saved.',
                    );
                }}
              >
                Save limits
              </Button>
            )}
          </div>
        </Disclosure>
        {admin && (
          <Disclosure title="Pause every new call">
            <p className="text-small">
              Active calls can finish. All new dialing and browser sessions are paused.
            </p>
            <div>
              <Button
                kind={settings.data?.kill_switch ? 'secondary' : 'danger'}
                onClick={() => {
                  if (
                    settings.data &&
                    (settings.data.kill_switch || confirm('Pause new calls across this workspace?'))
                  )
                    act(
                      '/settings',
                      'PUT',
                      { ...settings.data, kill_switch: !settings.data.kill_switch },
                      settings.data.kill_switch ? 'New calls allowed.' : 'New calls paused.',
                    );
                }}
              >
                {settings.data?.kill_switch ? 'Allow new calls' : 'Pause all new calls'}
              </Button>
            </div>
          </Disclosure>
        )}
      </section>
    </div>
  );
}
