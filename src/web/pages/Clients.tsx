import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { IconPlus, IconRefresh, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import type { Candidate, Client, Media, Provider } from '../../shared/types';
import { PLATFORM_ORDER } from '../../shared/rules';
import { api, connectUrl, mediaUrl } from '../api';
import { useApp } from '../context';
import { formatBytes, formatDuration } from '../format';
import { navigate } from '../router';
import { AccountLabel, Avatar, Modal, Notice, PlatformIcon, Topbar } from '../components/ui';

export function Clients() {
  const { clients, reloadClients } = useApp();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = await api.createClient({ name });
      await reloadClients();
      navigate(`#/clients/${c.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const active = clients.filter((c) => !c.archived);
  const archived = clients.filter((c) => c.archived);
  return (
    <div className="page-content">
      <Topbar title={<><IconUsersGroup size={16} /> Clients</>} />
      <div className="settings">
        <div className="settings-inner">
          <form className="card inline-form" onSubmit={add}>
            <input className="input" placeholder="New client name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New client name" required />
            <button className="btn btn-primary btn-lg">
              <IconPlus size={14} /> Add client
            </button>
          </form>
          {error && <Notice kind="error">{error}</Notice>}
          {!clients.length && <div className="empty-state">No clients yet. Add one, then connect its accounts.</div>}
          <div className="client-list">
            {[...active, ...archived].map((c) => (
              <a key={c.id} className={`card client-row${c.archived ? ' archived' : ''}`} href={`#/clients/${c.id}`}>
                <div className="client-name">
                  {c.name}
                  {c.archived && <span className="hint"> · archived</span>}
                </div>
                <div className="client-accounts">
                  {c.accounts.length ? c.accounts.map((a) => <Avatar key={a.id} account={a} size={22} />) : <span className="hint">No accounts connected</span>}
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const CONNECT: { provider: Provider; label: string; note: string; icons: ('instagram' | 'facebook' | 'youtube' | 'tiktok')[] }[] = [
  { provider: 'meta', label: 'Facebook & Instagram', note: 'Sign in with a Facebook login that manages the client’s Page. Instagram must be a Business or Creator account linked to that Page.', icons: ['instagram', 'facebook'] },
  { provider: 'tiktok', label: 'TikTok', note: 'Sign in with the client’s TikTok account.', icons: ['tiktok'] },
  { provider: 'google', label: 'YouTube', note: 'Sign in with the Google account that owns the channel (pick the channel if asked).', icons: ['youtube'] },
];

function CandidatePicker({ connectionId, onDone }: { connectionId: string; onDone: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    api.candidates(connectionId).then((list) => {
      setCandidates(list);
      setPicked(new Set(list.filter((c) => c.added).map((c) => c.id)));
    }, (err) => setError((err as Error).message));
  }, [connectionId]);
  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const save = async () => {
    try {
      await api.addCandidates(connectionId, [...picked]);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal title="Choose this client’s Pages and Instagram accounts" onClose={onDone} wide>
      <p className="hint">This Facebook login manages these accounts. Tick the ones that belong to this client.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {!candidates ? (
        <div className="hint">Loading…</div>
      ) : (
        <div className="pick-list">
          {candidates.map((c) => (
            <label key={c.id} className="pick-row">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <Avatar account={c} size={24} />
              <span className="acct-name">{c.name}</span>
              <span className="acct-handle">{c.handle}</span>
            </label>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn btn-secondary btn-lg" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-primary btn-lg" onClick={() => void save()} disabled={!picked.size}>
          Add {picked.size} account{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </Modal>
  );
}

function MediaLibrary({ clientId }: { clientId: string }) {
  const [items, setItems] = useState<Media[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => api.media(clientId).then(setItems, (err) => setError((err as Error).message)), [clientId]);
  useEffect(() => void load(), [load]);
  const remove = async (m: Media) => {
    if (!window.confirm(`Delete ${m.fileName}?`)) return;
    try {
      await api.deleteMedia(m.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card" aria-label="Media">
      <h2>Media</h2>
      <p>Files uploaded for this client’s posts.</p>
      {error && <Notice kind="error" onClose={() => setError('')}>{error}</Notice>}
      {!items.length ? (
        <div className="hint">No files yet. They’re added from the post composer.</div>
      ) : (
        <div className="media-grid">
          {items.map((m) => (
            <figure key={m.id} className="media-tile">
              {m.kind === 'image' ? <img src={mediaUrl(m.id)} alt="" /> : <video src={mediaUrl(m.id)} preload="metadata" muted />}
              <figcaption>
                <span className="media-name" title={m.fileName}>{m.fileName}</span>
                <span className="hint">
                  {formatBytes(m.size)} {m.durationMs ? `· ${formatDuration(m.durationMs)}` : ''}
                </span>
                <button className="icon-btn" onClick={() => void remove(m)} aria-label={`Delete ${m.fileName}`}>
                  <IconTrash size={14} />
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

export function ClientDetail({ id, query }: { id: string; query: URLSearchParams }) {
  const { status, reloadClients, user } = useApp();
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState(query.get('error') ?? '');
  const [message, setMessage] = useState(query.get('connected') ? `${query.get('connected')} is connected.` : '');
  const [pick, setPick] = useState(query.get('pick'));
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    try {
      const c = await api.client(id);
      setClient(c);
      setNotes(c.notes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  // Clear the one-off messages from the address once read.
  useEffect(() => {
    if (query.toString()) window.history.replaceState(null, '', `#/clients/${id}`);
  }, [id, query]);

  if (!client) return <div className="page-content">{error ? <Notice kind="error">{error}</Notice> : <div className="loading">Loading…</div>}</div>;

  const rename = async () => {
    const name = window.prompt('Client name', client.name);
    if (!name?.trim()) return;
    setClient(await api.updateClient(id, { name }));
    await reloadClients();
  };
  const archive = async () => {
    setClient(await api.updateClient(id, { archived: !client.archived }));
    await reloadClients();
  };
  const del = async () => {
    if (!window.confirm(`Delete ${client.name}, its connected accounts, files and post history? This can’t be undone. Posts already published stay on the platforms.`)) return;
    await api.deleteClient(id);
    await reloadClients();
    navigate('#/clients');
  };
  const removeAccount = async (accountId: string, name: string) => {
    if (!window.confirm(`Disconnect ${name} from ${client.name}?`)) return;
    try {
      await api.removeAccount(accountId);
      await load();
      await reloadClients();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const refresh = async (accountId: string) => {
    try {
      await api.refreshAccount(accountId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const sorted = [...client.accounts].sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));

  return (
    <div className="page-content">
      <Topbar
        title={
          <>
            <a className="crumb" href="#/clients">
              Clients
            </a>
            <span className="crumb">/</span>
            <span>{client.name}</span>
          </>
        }
      >
        <a className="btn btn-primary" href={`#/compose?clientId=${id}`}>
          New post
        </a>
        <a className="btn btn-secondary" href={`#/queue?clientId=${id}`}>
          Posts
        </a>
      </Topbar>
      <div className="settings">
        <div className="settings-inner">
          {message && <Notice kind="success" onClose={() => setMessage('')}>{message}</Notice>}
          {error && <Notice kind="error" onClose={() => setError('')}>{error}</Notice>}
          <section className="card" aria-label="Connected accounts">
            <h2>Connected accounts</h2>
            {sorted.length ? (
              <div className="account-list">
                {sorted.map((a) => (
                  <div key={a.id} className="account-row">
                    <AccountLabel account={a} showPlatform />
                    {a.status === 'reconnect' && <span className="hint error-text">{a.statusDetail}</span>}
                    <span className="spacer" />
                    {a.platform === 'tiktok' && (
                      <button className="icon-btn" title="Re-read settings from TikTok" aria-label={`Refresh ${a.name}`} onClick={() => void refresh(a.id)}>
                        <IconRefresh size={14} />
                      </button>
                    )}
                    <button className="icon-btn" title="Disconnect" aria-label={`Disconnect ${a.name}`} onClick={() => void removeAccount(a.id, a.name)}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">Nothing connected yet.</div>
            )}
            <div className="connect-grid">
              {CONNECT.map((c) => (
                <div key={c.provider} className="connect-option">
                  <div className="connect-title">
                    {c.icons.map((p) => (
                      <PlatformIcon key={p} platform={p} size={16} />
                    ))}
                    {c.label}
                  </div>
                  <p className="hint">{c.note}</p>
                  {status.providers[c.provider] ? (
                    <a className="btn btn-secondary" href={connectUrl(c.provider, id)}>
                      Connect
                    </a>
                  ) : (
                    <span className="hint">Not set up on the server yet (see README).</span>
                  )}
                </div>
              ))}
            </div>
            <p className="hint">To reconnect an account whose sign-in expired, connect it again; it keeps its scheduled posts.</p>
          </section>
          <MediaLibrary clientId={id} />
          <section className="card" aria-label="Notes">
            <h2>Notes</h2>
            <textarea className="input textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => void api.updateClient(id, { notes })} placeholder="Hashtags to use, posting times, approvals…" />
          </section>
          <section className="card" aria-label="Client settings">
            <div className="button-row">
              <button className="btn btn-secondary btn-lg" onClick={() => void rename()}>
                Rename
              </button>
              <button className="btn btn-secondary btn-lg" onClick={() => void archive()}>
                {client.archived ? 'Unarchive' : 'Archive'}
              </button>
              {user.role === 'admin' && (
                <button className="btn btn-secondary btn-lg btn-danger" onClick={() => void del()}>
                  <IconTrash size={14} /> Delete client
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
      {pick && (
        <CandidatePicker
          connectionId={pick}
          onDone={() => {
            setPick(null);
            void load();
            void reloadClients();
          }}
        />
      )}
    </div>
  );
}
