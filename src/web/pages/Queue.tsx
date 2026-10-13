// All posts, grouped by day: upcoming, drafts, published and failed.
import { useEffect, useMemo, useState } from 'react';
import { IconCalendarEvent, IconPhoto } from '@tabler/icons-react';
import type { Post, TargetStatus } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../context';
import { dayKey, firstLine, formatDay, formatTime } from '../format';
import { useStoredState } from '../hooks';
import { navigate, useRoute } from '../router';
import { Avatar, Notice, StatusBadge, Topbar, overallStatus } from '../components/ui';

type View = 'upcoming' | 'drafts' | 'published' | 'problems';

const VIEWS: { key: View; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'published', label: 'Published' },
  { key: 'problems', label: 'Failed' },
];

function inView(view: View, status: TargetStatus): boolean {
  switch (view) {
    case 'upcoming':
      return status === 'scheduled' || status === 'publishing';
    case 'drafts':
      return status === 'draft';
    case 'published':
      return status === 'published';
    case 'problems':
      return status === 'failed';
  }
}

export function Queue() {
  const { clients } = useApp();
  const route = useRoute();
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useStoredState<View>('gungnir.queueView', 'upcoming');
  const clientId = route.query.get('clientId') ?? '';

  useEffect(() => {
    const load = () => api.posts(clientId ? { clientId } : {}).then(setPosts, (err) => setError((err as Error).message));
    void load();
    // Keep statuses fresh while posts are going out.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [clientId]);

  const accounts = useMemo(() => new Map(clients.flatMap((c) => c.accounts).map((a) => [a.id, a])), [clients]);
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const counts = useMemo(() => {
    const c: Record<View, number> = { upcoming: 0, drafts: 0, published: 0, problems: 0 };
    for (const p of posts ?? []) for (const v of VIEWS) if (inView(v.key, overallStatus(p.targets.map((t) => t.status)))) c[v.key]++;
    return c;
  }, [posts]);

  const shown = (posts ?? [])
    .filter((p) => inView(view, overallStatus(p.targets.map((t) => t.status))))
    .sort((a, b) => {
      const ta = a.scheduledAt ?? a.updatedAt;
      const tb = b.scheduledAt ?? b.updatedAt;
      return view === 'upcoming' ? ta - tb : tb - ta;
    });
  const groups: { key: string; label: string; posts: Post[] }[] = [];
  for (const p of shown) {
    const t = p.scheduledAt ?? p.updatedAt;
    const key = view === 'drafts' ? 'drafts' : dayKey(t);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, label: view === 'drafts' ? 'Drafts' : formatDay(t), posts: [] }));
    g.posts.push(p);
  }

  return (
    <div className="page-content">
      <Topbar title={<><IconCalendarEvent size={16} /> Posts</>}>
        <select className="select" value={clientId} onChange={(e) => navigate(e.target.value ? `#/queue?clientId=${e.target.value}` : '#/queue')} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Topbar>
      <div className="viewbar">
        <div className="segmented" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
              {v.label}
              {counts[v.key] > 0 && <span className={`count${v.key === 'problems' ? ' error-text' : ''}`}> {counts[v.key]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="queue">
        {error && <Notice kind="error">{error}</Notice>}
        {posts && !groups.length && (
          <div className="empty-state">
            <h3>{view === 'upcoming' ? 'Nothing scheduled' : view === 'drafts' ? 'No drafts' : view === 'published' ? 'Nothing published yet' : 'No failed posts'}</h3>
            {view === 'upcoming' && (
              <a className="btn btn-primary btn-lg" href={clientId ? `#/compose?clientId=${clientId}` : '#/compose'}>
                New post
              </a>
            )}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.key} className="day">
            <h2 className="day-label">{g.label}</h2>
            {g.posts.map((p) => (
              <a key={p.id} className="post-row" href={`#/posts/${p.id}`}>
                <span className="post-time">{view === 'drafts' ? '' : formatTime(p.scheduledAt ?? p.updatedAt)}</span>
                <span className="post-media" title={`${p.mediaIds.length} file${p.mediaIds.length === 1 ? '' : 's'}`}>
                  {p.mediaIds.length > 0 && <IconPhoto size={14} />}
                  {p.mediaIds.length > 1 && <span className="hint">{p.mediaIds.length}</span>}
                </span>
                <span className="post-main">
                  <span className="post-caption">{firstLine(p.caption) || <span className="hint">No caption</span>}</span>
                  <span className="hint">{clientName.get(p.clientId)}</span>
                </span>
                <span className="post-targets">
                  {p.targets.map((t) => {
                    const a = accounts.get(t.accountId);
                    return a ? (
                      <span key={t.id} className={`target-dot status-${t.status}`} title={`${a.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`}>
                        <Avatar account={a} size={20} />
                      </span>
                    ) : null;
                  })}
                </span>
                <StatusBadge status={overallStatus(p.targets.map((t) => t.status))} />
              </a>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
