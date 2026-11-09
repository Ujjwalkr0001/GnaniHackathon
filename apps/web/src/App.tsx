import React, { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, LogOut } from 'lucide-react';
import { api, setCsrf } from './api.js';
import { PRODUCT_NAME } from './config.js';
import { copy } from './strings.js';
import { query, useData, type Providers } from './data.js';
import { Button, Card, Drawer, Field, Input, Skeleton, Toast } from './ui/index.js';
import { Brand } from './components/Brand.js';
import VoiceVisual from './components/VoiceVisual.js';
import Landing from './pages/Landing.js';
const Workspace = lazy(() => import('./pages/Workspace.js'));
const Studio = lazy(() => import('./pages/Studio.js'));
const Campaigns = lazy(() => import('./pages/Campaigns.js'));
const Wizard = lazy(() => import('./pages/Wizard.js'));
const Conversations = lazy(() => import('./pages/Conversations.js'));
const CampaignPage = lazy(() => import('./pages/CampaignPage.js'));
const Settings = lazy(() => import('./pages/Settings.js'));
interface Session {
  email: string;
  role: 'admin' | 'viewer';
  csrf: string;
}
const Context = createContext<{
  user: Session;
  notify: (message: string) => void;
  providers?: Providers;
}>({ user: { email: '', role: 'viewer', csrf: '' }, notify: () => {} });
export const useApp = () => useContext(Context);
export default function App() {
  const [user, setUser] = useState<Session | null>(),
    [toast, setToast] = useState(''),
    [privacy, setPrivacy] = useState(false);
  const location = useLocation(),
    navigate = useNavigate();
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme');
    document.title = PRODUCT_NAME;
    api<Session>('/auth/me')
      .then((u) => {
        setCsrf(u.csrf);
        setUser(u);
      })
      .catch(() => setUser(null));
  }, []);
  if (location.pathname === '/') return <Landing signedIn={!!user} />;
  const requested = new URLSearchParams(location.search).get('next');
  const afterLogin =
    requested && /^\/(agents\/|campaigns|settings|conversations|workspace)/.test(requested)
      ? requested
      : '/workspace';
  if (location.pathname === '/login')
    return user ? (
      <Navigate to={afterLogin} replace />
    ) : (
      <Login
        onLogin={(u) => {
          setUser(u);
          navigate(afterLogin, { replace: true });
        }}
      />
    );
  if (user === undefined)
    return (
      <div className="login-page">
        <div style={{ width: 320 }}>
          <Skeleton lines={2} />
        </div>
      </div>
    );
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return (
    <Context.Provider value={{ user, notify: setToast }}>
      <Shell
        user={user}
        logout={() => {
          void api('/auth/logout', 'POST')
            .then(() => {
              query.clear();
              setUser(null);
              navigate('/');
            })
            .catch((e) => setToast(e.message));
        }}
        privacy={() => setPrivacy(true)}
      >
        <Suspense fallback={<Skeleton />}>
          <Routes>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/agents/:workflow" element={<Studio />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/new" element={<Wizard />} />
            <Route path="/campaigns/new/:workflow" element={<Wizard />} />
            <Route path="/campaigns/:id/edit" element={<Wizard />} />
            <Route path="/campaigns/:id" element={<CampaignPage />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/leads" element={<Navigate to="/conversations" replace />} />
            <Route path="/candidates" element={<Navigate to="/conversations" replace />} />
            <Route path="/analytics" element={<Navigate to="/campaigns" replace />} />
            <Route path="/compliance" element={<Navigate to="/settings#privacy" replace />} />
            <Route path="*" element={<Navigate to="/workspace" replace />} />
          </Routes>
        </Suspense>
      </Shell>
      {toast && <Toast message={toast} onClose={() => setToast('')} />}
      {privacy && (
        <Drawer title="Privacy & calling rules" onClose={() => setPrivacy(false)}>
          <div className="stack">
            <p>
              Every call opens with an AI introduction. Recording is off. Call results and redacted
              transcripts are stored for 30 days by default; your administrator can change
              retention.
            </p>
            <p>
              Operators must obtain consent and meet applicable telemarketing and national
              do-not-call requirements. This app does not scrub the national registry.
            </p>
            <p>
              Screening is advisory. Humans make hiring decisions. Use synthetic data in public
              demonstrations.
            </p>
            <Link className="link" to="/settings#privacy" onClick={() => setPrivacy(false)}>
              Manage data & privacy
            </Link>
          </div>
        </Drawer>
      )}
      <span className="sr-only">{location.pathname}</span>
    </Context.Provider>
  );
}
function Shell({
  user,
  logout,
  privacy,
  children,
}: {
  user: Session;
  logout: () => void;
  privacy: () => void;
  children: React.ReactNode;
}) {
  const location = useLocation(),
    providers = useData<Providers>('/providers'),
    settings = useData<{ kill_switch: boolean }>('/settings');
  return (
    <Context.Provider value={{ ...useApp(), providers: providers.data }}>
      <a className="sr-only skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Brand to="/workspace" />
          <nav className="primary-nav" aria-label="Primary">
            {copy.nav.map((name, i) => (
              <NavLink
                to={['/workspace', '/conversations', '/settings'][i]}
                key={name}
                className={({ isActive }) =>
                  isActive || (i === 0 && /^\/(agents|campaigns)/.test(location.pathname))
                    ? 'active'
                    : ''
                }
              >
                {name}
              </NavLink>
            ))}
          </nav>
          <div className="header-actions">
            <details className="user-menu">
              <summary aria-label="Account menu">{user.email[0].toUpperCase()}</summary>
              <div className="user-dropdown">
                <strong>{user.email}</strong>
                <p>{user.role === 'admin' ? 'Administrator' : 'Read-only access'}</p>
                <Button kind="ghost" onClick={logout}>
                  <LogOut size={16} />
                  Sign out
                </Button>
              </div>
            </details>
          </div>
        </div>
      </header>
      <main id="main" className="app-main">
        {providers.data?.simulation && (
          <div className="banner">
            <span className="dot" />
            {copy.simulation}
          </div>
        )}
        {settings.data?.kill_switch && (
          <div className="banner banner-error">New calls are paused across your workspace.</div>
        )}
        {children}
      </main>
      <footer className="app-footer">
        <span>{PRODUCT_NAME} · Calling workspace</span>
        <div className="row">
          <Link to="/settings#status">
            <span className="dot" />
            Status
          </Link>
          <button onClick={privacy}>Privacy & calling rules</button>
        </div>
      </footer>
    </Context.Provider>
  );
}
function Login({ onLogin }: { onLogin: (user: Session) => void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth-page">
      <div className="auth-form-side">
        <Brand />
        <Link to="/" className="auth-back">
          <ArrowLeft size={15} /> Back to home
        </Link>
        <Card className="login-card">
          <span className="eyebrow">YOUR NEXT CONVERSATION STARTS HERE</span>
          <h1>Welcome back.</h1>
          <p>Sign in to bring your conversations together.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              void api<Session>('/auth/login', 'POST', { email, password })
                .then((u) => {
                  setCsrf(u.csrf);
                  onLogin(u);
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <div className="form-fields">
              <Field label="Email address">
                <Input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
            </div>
            {error && (
              <p className="field-error" role="alert" style={{ marginTop: 16 }}>
                {error}
              </p>
            )}
            <Button kind="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'} {!busy && <ArrowUpRight size={17} />}
            </Button>
          </form>
        </Card>
        <p className="auth-note">Need an account? Ask your workspace administrator.</p>
      </div>
      <aside className="auth-art">
        <span className="eyebrow">LESS FRICTION. MORE CONNECTION.</span>
        <h2>
          Good conversations.
          <br />
          Great possibilities.
        </h2>
        <VoiceVisual />
        <p>
          From your first sales hello to your next great hire.
          <br />
          One calm, connected workspace.
        </p>
      </aside>
    </main>
  );
}
