// First-run setup, sign-in, and accepting an invite.
import { useEffect, useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { Notice } from '../components/ui';

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="workspace-name auth-brand">
          <span className="workspace-logo">G</span> Gungnir
        </div>
        <h1>{title}</h1>
        {sub && <p className="hint">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<User>, onDone: (u: User) => void) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

export function Setup({ onDone }: { onDone: (u: User) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(() => api.setup({ name, email, password }), onDone);
  return (
    <Shell title="Set up Gungnir" sub="Create the first account. It becomes an admin who can invite the rest of the team.">
      <form className="form" onSubmit={submit}>
        <label>
          Your name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Email
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoComplete="new-password" />
          <span className="hint">At least 10 characters.</span>
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          Create admin account
        </button>
      </form>
    </Shell>
  );
}

export function Login({ onDone }: { onDone: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(() => api.login({ email, password }), onDone);
  return (
    <Shell title="Sign in">
      <form className="form" onSubmit={submit}>
        <label>
          Email
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
        </label>
        <label>
          Password
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          Sign in
        </button>
        <p className="hint">New to the team? Ask an admin for an invite link.</p>
      </form>
    </Shell>
  );
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: (u: User) => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useSubmit(() => api.acceptInvite({ token, name, password }), onDone);
  useEffect(() => {
    api.checkInvite(token).then((r) => setEmail(r.email), (err) => setInvalid((err as Error).message));
  }, [token]);
  if (invalid) {
    return (
      <Shell title="Invite link not valid">
        <Notice kind="error">{invalid}</Notice>
        <a className="btn btn-secondary btn-lg" href="#/">
          Go to sign in
        </a>
      </Shell>
    );
  }
  return (
    <Shell title="Join the team" sub={email ? `You're joining as ${email}.` : 'Checking your invite…'}>
      <form className="form" onSubmit={submit}>
        <label>
          Your name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Choose a password
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoComplete="new-password" />
          <span className="hint">At least 10 characters.</span>
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="btn btn-primary btn-lg" disabled={busy || !email}>
          Join
        </button>
      </form>
    </Shell>
  );
}
