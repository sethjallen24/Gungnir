// One post: what goes where, each account's status, links to the live posts, retries.
import { useCallback, useEffect, useState } from 'react';
import { IconExternalLink, IconPencil, IconRefresh, IconTrash } from '@tabler/icons-react';
import type { ActivityEntry, Client, Media, Post } from '../../shared/types';
import { api, mediaUrl } from '../api';
import { formatDateTime } from '../format';
import { navigate } from '../router';
import { AccountLabel, Notice, StatusBadge, Topbar, overallStatus } from '../components/ui';

export function PostDetail({ id }: { id: string }) {
  const [post, setPost] = useState<Post | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [files, setFiles] = useState<Media[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const p = await api.post(id);
      setPost(p);
      setActivity(await api.activity(id));
      // Fresh account details, so a sign-in that needs reconnecting shows here.
      setClient(await api.client(p.clientId));
      if (p.mediaIds.length) setFiles(await api.media(p.clientId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  if (!post) return <div className="page-content">{error ? <Notice kind="error">{error}</Notice> : <div className="loading">Loading…</div>}</div>;
  const accounts = new Map((client?.accounts ?? []).map((a) => [a.id, a]));
  const status = overallStatus(post.targets.map((t) => t.status));
  const editable = post.targets.some((t) => t.status !== 'published' && t.status !== 'publishing') || !post.targets.length;
  const cancellable = post.targets.some((t) => t.status === 'scheduled' || t.status === 'draft' || t.status === 'failed');
  const deletable = !post.targets.some((t) => t.status === 'published' || t.status === 'publishing');

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page-content">
      <Topbar
        title={
          <>
            <a className="crumb" href="#/queue">
              Posts
            </a>
            <span className="crumb">/</span>
            <span>{client?.name ?? 'Post'}</span>
            <StatusBadge status={status} />
          </>
        }
      >
        {editable && (
          <a className="btn btn-secondary" href={`#/posts/${id}/edit`}>
            <IconPencil size={14} /> Edit
          </a>
        )}
        {cancellable && (
          <button className="btn btn-secondary" onClick={() => void act(() => api.cancelPost(id))}>
            Cancel
          </button>
        )}
        {deletable && (
          <button
            className="btn btn-secondary btn-danger"
            onClick={() => window.confirm('Delete this post?') && void api.deletePost(id).then(() => navigate('#/queue'), (err) => setError((err as Error).message))}
          >
            <IconTrash size={14} /> Delete
          </button>
        )}
      </Topbar>
      <div className="settings">
        <div className="settings-inner">
          {error && <Notice kind="error" onClose={() => setError('')}>{error}</Notice>}
          <section className="card">
            <div className="hint">{post.scheduledAt == null ? 'Draft' : `${post.scheduledAt > Date.now() ? 'Scheduled for' : 'Set to post at'} ${formatDateTime(post.scheduledAt)}`}</div>
            {post.mediaIds.length > 0 && (
              <div className="media-strip">
                {post.mediaIds.map((m) => (
                  <figure key={m} className="media-tile small">
                    {files.find((f) => f.id === m)?.kind === 'video' ? <video src={mediaUrl(m)} preload="metadata" muted controls /> : <img src={mediaUrl(m)} alt="" />}
                  </figure>
                ))}
              </div>
            )}
            <div className="caption-view">{post.caption || <span className="hint">No caption</span>}</div>
          </section>
          <section className="card" aria-label="Accounts">
            <h2>Accounts</h2>
            {!post.targets.length && <div className="hint">No accounts picked yet.</div>}
            {post.targets.map((t) => {
              const a = accounts.get(t.accountId);
              return (
                <div key={t.id} className="target-status">
                  <div className="target-head">
                    {a ? <AccountLabel account={a} showPlatform /> : <span className="hint">Removed account</span>}
                    <StatusBadge status={t.status} />
                  </div>
                  {t.caption != null && <div className="caption-view small">{t.caption}</div>}
                  {t.status === 'published' && (
                    <div className="hint">
                      Published {formatDateTime(t.publishedAt)}
                      {t.externalUrl ? (
                        <>
                          {' · '}
                          <a href={t.externalUrl} target="_blank" rel="noreferrer">
                            View post <IconExternalLink size={12} />
                          </a>
                        </>
                      ) : (
                        a?.platform === 'tiktok' && ' · TikTok gives no link for private posts; it can take a few minutes to appear on the profile.'
                      )}
                    </div>
                  )}
                  {t.status === 'scheduled' && t.attempts > 0 && <div className="hint">Will try again {formatDateTime(t.nextAttemptAt)}.</div>}
                  {t.status === 'publishing' && <div className="hint">Uploading or waiting for the platform to finish processing…</div>}
                  {t.error && <div className={t.status === 'failed' ? 'problem' : 'hint'}>{t.error}</div>}
                  {(t.status === 'failed' || t.status === 'cancelled') && (
                    <button className="btn btn-secondary" onClick={() => void act(() => api.retryTarget(t.id))}>
                      <IconRefresh size={14} /> {t.status === 'failed' ? 'Try again' : 'Post it'}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
          {activity.length > 0 && (
            <section className="card" aria-label="History">
              <h2>History</h2>
              <ul className="activity">
                {activity.map((e, i) => (
                  <li key={i}>
                    <span className="hint">{formatDateTime(e.at)}</span> {e.userName ?? 'Gungnir'} {e.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
