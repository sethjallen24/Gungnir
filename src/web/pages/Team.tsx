import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { IconCopy, IconTrash, IconUser, IconUsers } from '@tabler/icons-react';
import type { User } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../context';
import { formatDateTime } from '../format';
import { Notice, Topbar } from '../components/ui';

export function Team() {
  const { user } = useApp();
  const admin = user.role === 'admin';
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<{ id: string; email: string; role: string; expiresAt: number }[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [link, setLink] = useState<{ link: string; email: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers(await api.users());
      if (admin) setInvites(await api.invites());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [admin]);
  useEffect(() => void load(), [load]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setLink(await api.invite({ email, role }));
      setEmail('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const update = async (id: string, patch: { role?: string; disabled?: boolean }) => {
    try {
      await api.updateUser(id, patch);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page-content">
      <Topbar title={<><IconUsers size={16} /> Team</>} />
      <div className="settings">
        <div className="settings-inner">
          {error && <Notice kind="error" onClose={() => setError('')}>{error}</Notice>}
          <section className="card" aria-label="Members">
            <h2>Members</h2>
            <p>Everyone on the team can manage every client and post. Admins can also invite people, change roles and delete clients.</p>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {admin && <th />}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.disabled ? 'muted-row' : ''}>
                    <td>
                      {u.name}
                      {u.disabled && <span className="hint"> · no access</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      {admin && u.id !== user.id ? (
                        <select className="select" value={u.role} onChange={(e) => void update(u.id, { role: e.target.value })} aria-label={`Role for ${u.name}`}>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      ) : u.role === 'admin' ? (
                        'Admin'
                      ) : (
                        'Member'
                      )}
                    </td>
                    {admin && (
                      <td className="num">
                        {u.id !== user.id && (
                          <button className="btn" onClick={() => void update(u.id, { disabled: !u.disabled })}>
                            {u.disabled ? 'Restore access' : 'Remove access'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {admin && (
            <section className="card" aria-label="Invite">
              <h2>Invite someone</h2>
              <p>Makes a sign-up link that works once, for 7 days. Send it to them yourself.</p>
              <form className="inline-form" onSubmit={invite}>
                <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Invite email" />
                <select className="input narrow" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Invite role">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button className="btn btn-primary btn-lg">Create link</button>
              </form>
              {link && (
                <Notice kind="success" onClose={() => setLink(null)}>
                  Send this link to {link.email}:
                  <div className="copy-row">
                    <input className="input path" readOnly value={link.link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
                    <button className="btn btn-secondary" onClick={() => void navigator.clipboard?.writeText(link.link)}>
                      <IconCopy size={14} /> Copy
                    </button>
                  </div>
                </Notice>
              )}
              {invites.length > 0 && (
                <div className="invite-list">
                  <div className="hint">Waiting to be accepted:</div>
                  {invites.map((i) => (
                    <div key={i.id} className="account-row">
                      <span>{i.email}</span>
                      <span className="hint">
                        {i.role} · expires {formatDateTime(i.expiresAt)}
                      </span>
                      <span className="spacer" />
                      <button className="icon-btn" aria-label={`Withdraw invite for ${i.email}`} onClick={() => void api.deleteInvite(i.id).then(load)}>
                        <IconTrash size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export function AccountPage() {
  const { user, signOut } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.changePassword({ current, password: next });
      setCurrent('');
      setNext('');
      setMsg({ kind: 'success', text: 'Password changed.' });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };
  return (
    <div className="page-content">
      <Topbar title={<><IconUser size={16} /> Your account</>} />
      <div className="settings">
        <div className="settings-inner">
          <section className="card">
            <h2>{user.name}</h2>
            <p>
              {user.email} · {user.role === 'admin' ? 'Admin' : 'Member'}
            </p>
            <form className="form" onSubmit={save}>
              <label>
                Current password
                <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
              </label>
              <label>
                New password
                <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} required autoComplete="new-password" />
              </label>
              {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
              <div className="button-row">
                <button className="btn btn-primary btn-lg">Change password</button>
                <button type="button" className="btn btn-secondary btn-lg" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
