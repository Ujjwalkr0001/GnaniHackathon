import {
  AudioLines,
  ArrowUpRight,
  Check,
  ExternalLink,
  Link2,
  Phone,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '../App.js';
import { Card, Chip, Disclosure, Skeleton } from '../ui/index.js';
const guides = [
  {
    name: 'Twilio',
    description: 'Your phone connection',
    icon: Phone,
    console: 'https://console.twilio.com/',
    keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
    note: 'Choose a voice-enabled number. The server uses your public HTTPS base URL for signed voice and status webhooks.',
  },
  {
    name: 'Gnani',
    description: 'The voice behind your agent',
    icon: AudioLines,
    console: 'https://www.gnani.ai/',
    keys: ['GNANI_STT', 'GNANI_TTS'],
    note: 'Prisma recognizes the caller; Timbre speaks the agent reply. A single GNANI_API_KEY is also supported.',
  },
  {
    name: 'Groq',
    description: 'The conversation behind the voice',
    icon: Link2,
    console: 'https://console.groq.com/keys',
    keys: ['GROQ_API_KEY'],
    note: 'Groq handles dialogue and grounded post-call summaries. The default model is Qwen 3.8 27B. Explicit DIALOGUE_* settings can select another compatible model.',
  },
];
export default function Connections() {
  const { providers } = useApp();
  return (
    <section id="connections" className="settings-section connections-section">
      <span className="eyebrow">MAKE YOUR FIRST CONNECTION</span>
      <h2>Your voice. Your number. Your workspace.</h2>
      <p>
        Connect the services behind your calls. Credentials are managed on the server and never
        shown in the browser.
      </p>
      {!providers ? (
        <Skeleton lines={2} />
      ) : (
        <div className="connection-grid">
          {guides.map((g) => {
            const service = providers.services.find((s) =>
              s.name.includes(g.name === 'Groq' ? 'Dialogue' : g.name),
            );
            return (
              <Card className="connection-card" key={g.name}>
                <div className="row between">
                  <span className="mint-icon">
                    <g.icon size={22} />
                  </span>
                  <Chip
                    tone={
                      !providers.simulation && service?.status.includes('configured')
                        ? 'positive'
                        : 'neutral'
                    }
                  >
                    {providers.simulation
                      ? 'Simulation'
                      : service?.status.includes('configured')
                        ? 'Configured'
                        : 'Needs setup'}
                  </Chip>
                </div>
                <h3>{g.name}</h3>
                <p>{g.description}</p>
                <Disclosure title="Setup guide">
                  <p>{g.note}</p>
                  <p className="helper">
                    Set these variables in your server’s private environment:
                  </p>
                  <ul className="environment-keys">
                    {g.keys.map((k) => (
                      <li key={k}>
                        <code>{k}</code>
                      </li>
                    ))}
                  </ul>
                  <a href={g.console} target="_blank" rel="noreferrer" className="text-link">
                    Open {g.name}
                    <ExternalLink size={14} />
                  </a>
                </Disclosure>
              </Card>
            );
          })}
        </div>
      )}
      <div className="connection-checklist">
        <ShieldCheck size={19} />
        <div>
          <h3>
            {providers?.simulation
              ? 'You’re in simulation mode. Explore freely.'
              : 'Live calling uses your server’s configuration.'}
          </h3>
          <p>
            {providers?.simulation
              ? 'No real number will be dialled. After your administrator configures providers, a public HTTPS URL and live mode, restart the server to enable live calls.'
              : 'Configured status is not a live connection test. Check the first call and provider dashboards before running a campaign.'}
          </p>
        </div>
      </div>
      <Disclosure title="Live calling checklist">
        <div className="setup-check">
          <Check size={15} />
          <span>Twilio voice number, account SID and auth token configured.</span>
        </div>
        <div className="setup-check">
          <Check size={15} />
          <span>Gnani STT/TTS and Groq dialogue configured.</span>
        </div>
        <div className="setup-check">
          <Check size={15} />
          <span>TWILIO_WEBHOOK_BASE_URL points to your server over public HTTPS. PUBLIC_BASE_URL can remain localhost for the dashboard.</span>
        </div>
        <div className="setup-check">
          <Check size={15} />
          <span>MOCK_MODE=false and the server restarted by your administrator.</span>
        </div>
        <div className="setup-check">
          <Check size={15} />
          <span>Contact consent, test allowlist and calling hours checked.</span>
        </div>
        <a
          href="https://console.twilio.com/"
          target="_blank"
          rel="noreferrer"
          className="text-link"
        >
          Manage your Twilio account
          <ArrowUpRight size={15} />
        </a>
      </Disclosure>
    </section>
  );
}
