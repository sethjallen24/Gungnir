import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconCalendarEvent, IconLogout, IconPencilPlus, IconUser, IconUsers, IconUsersGroup } from '@tabler/icons-react';
import type { Client, ServerStatus, User } from '../shared/types';
import { api, ApiError } from './api';
import { AppContext, type AppState } from './context';
import { useRoute, type Route } from './router';
import { AcceptInvite, Login, Setup } from './pages/Auth';
import { ClientDetail, Clients } from './pages/Clients';
import { Composer } from './pages/Composer';
import { PostDetail } from './pages/PostDetail';
import { Queue } from './pages/Queue';
import { AccountPage, Team } from './pages/Team';

function Sidebar({ route, clients, user, onSignOut }: { route: Route; clients: Client[]; user: User; onSignOut: () => void }) {
  const [first, second] = route.parts;
  const active = (key: string) => (first ?? 'queue') === key;
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="workspace">
        <span className="workspace-name">
          <span className="workspace-logo">G</span> Gungnir
        </span>
      </div>
      <a className="btn btn-primary btn-lg new-post" href="#/compose">
        <IconPencilPlus size={16} /> New post
      </a>
      <a className={`nav-item${active('queue') || active('posts') ? ' active' : ''}`} href="#/queue">
        <IconCalendarEvent size={16} /> Posts
      </a>
      <a className={`nav-item${active('clients') && !second ? ' active' : ''}`} href="#/clients">
        <IconUsersGroup size={16} /> Clients
      </a>
      <a className={`nav-item${active('team') ? ' active' : ''}`} href="#/team">
        <IconUsers size={16} /> Team
      </a>
      {clients.some((c) => !c.archived) && <div className="nav-section">Clients</div>}
      <div className="nav-list">
        {clients
          .filter((c) => !c.archived)
          .map((c) => (
            <a key={c.id} className={`nav-item${first === 'clients' && second === c.id ? ' active' : ''}`} href={`#/clients/${c.id}`} title={c.name}>
              <IconUser size={16} /> <span className="nav-label">{c.name}</span>
            </a>
          ))}
      </div>
      <div className="sync-status">
        <a href="#/account" className="nav-label" title="Your account">
          {user.name}
        </a>
        <button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={onSignOut}>
          <IconLogout size={14} />
        </button>
      </div>
    </nav>
  );
}

function Page({ route }: { route: Route }) {
  const [first, second, third] = route.parts;
  switch (first ?? 'queue') {
    case 'compose':
      return <Composer key={`new:${route.query.get('clientId') ?? ''}`} clientId={route.query.get('clientId')} />;
    case 'posts':
      if (second && third === 'edit') return <Composer key={`edit:${second}`} postId={second} />;
      if (second) return <PostDetail key={second} id={second} />;
      return <Queue />;
    case 'clients':
      return second ? <ClientDetail key={second} id={second} query={route.query} /> : <Clients />;
    case 'team':
      return <Team />;
    case 'account':
      return <AccountPage />;
    default:
      return <Queue />;
  }
}

export function App() {
  const route = useRoute();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.status().then(setStatus, (err) => setError((err as Error).message));
    api.me().then(setUser, (err) => (err instanceof ApiError && err.status === 401 ? setUser(null) : setError((err as Error).message)));
    const onSignedOut = () => setUser(null);
    window.addEventListener('gungnir:signed-out', onSignedOut);
    return () => window.removeEventListener('gungnir:signed-out', onSignedOut);
  }, []);

  const reloadClients = useCallback(async () => setClients(await api.clients()), []);
  useEffect(() => {
    if (user) void reloadClients();
  }, [user, reloadClients]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    window.location.hash = '#/';
  }, []);

  const state = useMemo<AppState | null>(
    () => (user && status ? { user, status, clients, reloadClients, signOut } : null),
    [user, status, clients, reloadClients, signOut],
  );

  if (error) return <div className="loading">Couldn't reach the server: {error}</div>;
  if (!status || user === undefined) return <div className="loading">Loading…</div>;
  const signedIn = (u: User) => {
    setUser(u);
    window.location.hash = '#/';
  };
  if (!user) {
    if (route.parts[0] === 'invite' && route.parts[1]) return <AcceptInvite token={route.parts[1]} onDone={signedIn} />;
    if (status.needsSetup) return <Setup onDone={(u) => (setStatus({ ...status, needsSetup: false }), signedIn(u))} />;
    return <Login onDone={signedIn} />;
  }
  return (
    <AppContext.Provider value={state}>
      <div className="app">
        <Sidebar route={route} clients={clients} user={user} onSignOut={() => void signOut()} />
        <main className="main">
          <div className="page">
            <Page route={route} />
          </div>
        </main>
      </div>
    </AppContext.Provider>
  );
}
