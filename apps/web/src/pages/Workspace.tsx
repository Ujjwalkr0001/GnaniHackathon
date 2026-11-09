import { Link } from 'react-router-dom';
import { ArrowUpRight, AudioLines } from 'lucide-react';
import { workflows } from '../workflows.js';
import { useApp } from '../App.js';
import { useData, type ResultRow } from '../data.js';
import { Waveform } from '../components/VoiceVisual.js';
export default function Workspace() {
  const { user } = useApp(),
    results = useData<ResultRow[]>('/results');
  return (
    <div className="workspace-page">
      <div className="workspace-welcome">
        <div>
          <div className="workspace-overline">
            <span className="green-dot" /> YOUR COMMUNICATION WORKSPACE
          </div>
          <h1>
            Automate conversations.
            <br />
            Amplify growth.
          </h1>
          <p>What can we take off your plate today?</p>
        </div>
        <div className="workspace-voice">
          <AudioLines size={25} />
          <Waveform compact />
          <span>One voice. Every team.</span>
        </div>
      </div>
      <section id="workflows" className="workflows-section">
        <div className="section-label">
          <h2>Choose your conversation</h2>
          <span>Five ways to make work feel lighter</span>
        </div>
        <div className="workflow-grid">
          {workflows.map((w, i) => (
            <Link to={`/agents/${w.id}`} key={w.id} className={`workflow-card workflow-${w.color}`}>
              <div className="workflow-card-top">
                <span className={`solution-icon tone-${w.color}`}>
                  <w.icon size={24} />
                </span>
                <span className="workflow-index">0{i + 1}</span>
              </div>
              <h3>{w.name}</h3>
              <p>{w.short}</p>
              <span className="workflow-card-action">
                {w.action}
                <ArrowUpRight size={17} />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <div className="workspace-footnote">
        <span>
          <AudioLines size={15} /> Built with Gnani speech. Connected through Twilio.
        </span>
        <span>
          {results.data
            ? `${results.data.length} saved conversations`
            : 'Your conversations, together'}{' '}
          · {user.role === 'admin' ? 'Administrator' : 'Read only'}
        </span>
      </div>
    </div>
  );
}
