// Writing and scheduling a post: one caption and set of files, sent to any of the client's
// accounts, with a caption override and options per account.
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowDown, IconArrowUp, IconPencilPlus, IconPhotoPlus, IconX } from '@tabler/icons-react';
import type { Account, Media, Post, PostInput, TargetOptions } from '../../shared/types';
import { LIMITS, PLATFORM_ORDER, TIKTOK_PRIVACY_LABEL, charCount, checkPost } from '../../shared/rules';
import { api, mediaUrl, uploadMedia } from '../api';
import { useApp } from '../context';
import { formatBytes, formatDuration, fromLocalInput, toLocalInput } from '../format';
import { navigate } from '../router';
import { AccountLabel, Modal, Notice, PlatformIcon, Topbar } from '../components/ui';

interface TargetDraft {
  caption: string | null;
  options: TargetOptions;
}

interface Upload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/** Reads a file's dimensions and duration in the browser, for the platform checks. */
function probe(file: File): Promise<{ width?: number; height?: number; durationMs?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (info: { width?: number; height?: number; durationMs?: number }) => {
      URL.revokeObjectURL(url);
      resolve(info);
    };
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, durationMs: Number.isFinite(v.duration) ? v.duration * 1000 : undefined });
      v.onerror = () => done({});
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    }
  });
}

const nextHour = () => {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

function defaultOptions(a: Account, caption: string): TargetOptions {
  switch (a.platform) {
    case 'youtube':
      return { title: caption.split('\n')[0].slice(0, 100), youtubePrivacy: 'public', youtubeMadeForKids: false };
    case 'instagram':
      return { instagramShareToFeed: true };
    case 'tiktok':
      // TikTok requires the person to choose: no privacy default, interactions off until ticked.
      return { tiktokDisableComment: true, tiktokDisableDuet: true, tiktokDisableStitch: true };
    default:
      return {};
  }
}

function TikTokOptions({ account, options, set, video }: { account: Account; options: TargetOptions; set: (o: TargetOptions) => void; video: boolean }) {
  const privacyOptions = (account.meta.privacyOptions as string[] | undefined) ?? [];
  const meta = account.meta as { commentDisabled?: boolean; duetDisabled?: boolean; stitchDisabled?: boolean };
  const allow = (key: 'tiktokDisableComment' | 'tiktokDisableDuet' | 'tiktokDisableStitch', label: string, off?: boolean) => (
    <label className={`check-row${off ? ' disabled' : ''}`} title={off ? 'Turned off in this account’s TikTok settings' : undefined}>
      <input type="checkbox" disabled={off} checked={!off && !options[key]} onChange={(e) => set({ ...options, [key]: !e.target.checked })} /> {label}
    </label>
  );
  return (
    <div className="options">
      <label className="field">
        Who can see this video
        <select className="input" value={options.tiktokPrivacy ?? ''} onChange={(e) => set({ ...options, tiktokPrivacy: e.target.value || undefined })}>
          <option value="">Choose…</option>
          {privacyOptions.map((p) => (
            <option key={p} value={p} disabled={p === 'SELF_ONLY' && !!options.tiktokBrandedContent}>
              {TIKTOK_PRIVACY_LABEL[p] ?? p}
            </option>
          ))}
        </select>
      </label>
      <div className="check-group">
        {allow('tiktokDisableComment', 'Allow comments', meta.commentDisabled)}
        {video && allow('tiktokDisableDuet', 'Allow Duet', meta.duetDisabled)}
        {video && allow('tiktokDisableStitch', 'Allow Stitch', meta.stitchDisabled)}
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!options.tiktokDisclose}
          onChange={(e) => set({ ...options, tiktokDisclose: e.target.checked, ...(e.target.checked ? {} : { tiktokBrandOrganic: false, tiktokBrandedContent: false }) })}
        />
        Disclose video content (it promotes a brand, product or service)
      </label>
      {options.tiktokDisclose && (
        <div className="check-group indent">
          <label className="check-row">
            <input type="checkbox" checked={!!options.tiktokBrandOrganic} onChange={(e) => set({ ...options, tiktokBrandOrganic: e.target.checked })} /> Your brand: you’re promoting
            yourself or your own business. Labeled “Promotional content”.
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!options.tiktokBrandedContent}
              disabled={options.tiktokPrivacy === 'SELF_ONLY'}
              title={options.tiktokPrivacy === 'SELF_ONLY' ? 'Branded content can’t be private' : undefined}
              onChange={(e) => set({ ...options, tiktokBrandedContent: e.target.checked })}
            />{' '}
            Branded content: you’re promoting another brand or a third party. Labeled “Paid partnership”.
          </label>
        </div>
      )}
      <p className="hint">
        By posting, you agree to TikTok’s{' '}
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">
          Music Usage Confirmation
        </a>
        {options.tiktokDisclose && options.tiktokBrandedContent && (
          <>
            {' '}
            and{' '}
            <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">
              Branded Content Policy
            </a>
          </>
        )}
        .
      </p>
    </div>
  );
}

function PlatformOptions({ account, options, set, media }: { account: Account; options: TargetOptions; set: (o: TargetOptions) => void; media: Media[] }) {
  const video = media.length === 1 && media[0].kind === 'video';
  switch (account.platform) {
    case 'youtube':
      return (
        <div className="options">
          <label className="field">
            Title
            <input className="input" value={options.title ?? ''} maxLength={LIMITS.youtube.title} onChange={(e) => set({ ...options, title: e.target.value })} />
            <span className="hint">
              {charCount(options.title ?? '')}/{LIMITS.youtube.title}. Vertical videos up to 3 minutes become Shorts.
            </span>
          </label>
          <div className="field-row">
            <label className="field">
              Visibility
              <select className="input" value={options.youtubePrivacy ?? 'public'} onChange={(e) => set({ ...options, youtubePrivacy: e.target.value as TargetOptions['youtubePrivacy'] })}>
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </label>
            <label className="field">
              Made for kids
              <select className="input" value={options.youtubeMadeForKids ? 'yes' : 'no'} onChange={(e) => set({ ...options, youtubeMadeForKids: e.target.value === 'yes' })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
        </div>
      );
    case 'instagram':
      return video ? (
        <div className="options">
          <label className="check-row">
            <input type="checkbox" checked={options.instagramShareToFeed ?? true} onChange={(e) => set({ ...options, instagramShareToFeed: e.target.checked })} /> Posts as a Reel; also
            show it in the profile grid
          </label>
        </div>
      ) : null;
    case 'facebook':
      return media.some((m) => m.kind === 'video') ? (
        <div className="options">
          <label className="field">
            Video title (optional)
            <input className="input" value={options.title ?? ''} onChange={(e) => set({ ...options, title: e.target.value })} />
          </label>
        </div>
      ) : null;
    case 'tiktok':
      return <TikTokOptions account={account} options={options} set={set} video={video} />;
  }
}

function LibraryPicker({ clientId, exclude, onPick, onClose }: { clientId: string; exclude: string[]; onPick: (m: Media) => void; onClose: () => void }) {
  const [items, setItems] = useState<Media[] | null>(null);
  useEffect(() => void api.media(clientId).then(setItems), [clientId]);
  return (
    <Modal title="Add from this client’s files" onClose={onClose} wide>
      {!items ? (
        <div className="hint">Loading…</div>
      ) : !items.length ? (
        <div className="hint">No files uploaded for this client yet.</div>
      ) : (
        <div className="media-grid">
          {items
            .filter((m) => !exclude.includes(m.id))
            .map((m) => (
              <button key={m.id} className="media-tile pickable" onClick={() => onPick(m)}>
                {m.kind === 'image' ? <img src={mediaUrl(m.id)} alt="" /> : <video src={mediaUrl(m.id)} preload="metadata" muted />}
                <span className="media-name">{m.fileName}</span>
              </button>
            ))}
        </div>
      )}
    </Modal>
  );
}

export function Composer({ clientId: initialClient, postId }: { clientId?: string | null; postId?: string }) {
  const { clients } = useApp();
  const active = clients.filter((c) => !c.archived);
  const [clientId, setClientId] = useState(initialClient ?? (active.length === 1 ? active[0].id : ''));
  const [existing, setExisting] = useState<Post | null>(null);
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [targets, setTargets] = useState<Record<string, TargetDraft>>({});
  const [when, setWhen] = useState<'now' | 'later'>('later');
  const [at, setAt] = useState(toLocalInput(nextHour()));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [library, setLibrary] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const client = clients.find((c) => c.id === clientId) ?? null;

  // The client's accounts, read fresh so their current status shows (TikTok's settings are
  // re-read again when it's picked).
  useEffect(() => {
    if (!clientId) return setAccounts([]);
    api.client(clientId).then((c) => setAccounts(c.accounts), (err) => setError((err as Error).message));
  }, [clientId]);

  // Editing: load the post and its files.
  useEffect(() => {
    if (!postId) return;
    void (async () => {
      try {
        const p = await api.post(postId);
        const files = await api.media(p.clientId);
        setExisting(p);
        setClientId(p.clientId);
        setCaption(p.caption);
        setMedia(p.mediaIds.map((id) => files.find((f) => f.id === id)).filter((m): m is Media => !!m));
        setTargets(Object.fromEntries(p.targets.map((t) => [t.accountId, { caption: t.caption, options: t.options }])));
        if (p.scheduledAt) {
          setWhen(p.scheduledAt > Date.now() ? 'later' : 'now');
          setAt(toLocalInput(Math.max(p.scheduledAt, nextHour())));
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [postId]);

  const locked = new Set(existing?.targets.filter((t) => t.status === 'published' || t.status === 'publishing').map((t) => t.accountId));

  const toggle = async (a: Account) => {
    if (locked.has(a.id)) return;
    if (targets[a.id]) {
      const next = { ...targets };
      delete next[a.id];
      setTargets(next);
      return;
    }
    setTargets({ ...targets, [a.id]: { caption: null, options: defaultOptions(a, caption) } });
    if (a.platform === 'tiktok') {
      try {
        const fresh = await api.refreshAccount(a.id);
        setAccounts((list) => list.map((x) => (x.id === fresh.id ? fresh : x)));
      } catch (err) {
        setError(`Couldn’t read ${a.name}’s TikTok settings: ${(err as Error).message}`);
      }
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || !clientId) return;
    for (const file of [...files]) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const info = await probe(file);
        const m = await uploadMedia(clientId, file, info, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))));
        setMedia((list) => [...list, m]);
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: (err as Error).message } : x)));
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const move = (i: number, d: -1 | 1) => {
    const next = [...media];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setMedia(next);
  };

  const selected = accounts
    .filter((a) => targets[a.id])
    .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  const problems = useMemo(
    () => checkPost({ caption, media, targets: selected.filter((a) => !locked.has(a.id)).map((a) => ({ account: a, ...targets[a.id] })) }),
    [caption, media, targets, accounts, existing],
  );
  const general = problems.filter((p) => !p.accountId);

  const input = (scheduledAt: number | null): PostInput => ({
    clientId,
    caption,
    mediaIds: media.map((m) => m.id),
    scheduledAt,
    targets: selected.map((a) => ({ accountId: a.id, caption: targets[a.id].caption, options: targets[a.id].options })),
  });

  const save = async (mode: 'draft' | 'schedule') => {
    setError('');
    let scheduledAt: number | null = null;
    if (mode === 'schedule') {
      scheduledAt = when === 'now' ? Date.now() : fromLocalInput(at);
      if (scheduledAt == null) return setError('Pick a date and time.');
      if (when === 'later' && scheduledAt < Date.now() - 60_000) return setError('That time has passed. Pick a time in the future, or choose “Post now”.');
    }
    setBusy(true);
    try {
      const p = existing ? await api.updatePost(existing.id, input(scheduledAt)) : await api.createPost(input(scheduledAt));
      navigate(`#/posts/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const limits = selected.map((a) => (a.platform === 'youtube' ? LIMITS.youtube.description : a.platform === 'facebook' ? LIMITS.facebook.caption : LIMITS[a.platform].caption));
  const captionLimit = limits.length ? Math.min(...limits) : null;

  return (
    <div className="page-content">
      <Topbar title={<><IconPencilPlus size={16} /> {existing ? 'Edit post' : 'New post'}</>} />
      <div className="settings">
        <div className="settings-inner composer">
          {error && <Notice kind="error" onClose={() => setError('')}>{error}</Notice>}
          <section className="card">
            <label className="field">
              Client
              <select className="input" value={clientId} disabled={!!existing} onChange={(e) => (setClientId(e.target.value), setTargets({}), setMedia([]))}>
                <option value="">Choose a client…</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {client && (
              <div className="field">
                Post to
                {accounts.length ? (
                  <div className="account-toggles">
                    {[...accounts]
                      .sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform))
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`account-toggle${targets[a.id] ? ' on' : ''}`}
                          aria-pressed={!!targets[a.id]}
                          disabled={locked.has(a.id)}
                          title={locked.has(a.id) ? 'Already published here' : undefined}
                          onClick={() => void toggle(a)}
                        >
                          <AccountLabel account={a} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="hint">
                    {client.name} has no connected accounts. <a href={`#/clients/${client.id}`}>Connect them first.</a>
                  </div>
                )}
              </div>
            )}
          </section>

          {client && (
            <section className="card">
              <div className="field">
                Photos and videos
                <div className="media-strip">
                  {media.map((m, i) => (
                    <figure key={m.id} className="media-tile small">
                      {m.kind === 'image' ? <img src={mediaUrl(m.id)} alt="" /> : <video src={mediaUrl(m.id)} preload="metadata" muted />}
                      <figcaption>
                        <span className="hint">
                          {m.kind === 'video' ? formatDuration(m.durationMs) || 'Video' : 'Photo'} · {formatBytes(m.size)}
                        </span>
                        <span className="tile-actions">
                          {i > 0 && (
                            <button className="icon-btn" onClick={() => move(i, -1)} aria-label="Move earlier">
                              <IconArrowUp size={12} />
                            </button>
                          )}
                          {i < media.length - 1 && (
                            <button className="icon-btn" onClick={() => move(i, 1)} aria-label="Move later">
                              <IconArrowDown size={12} />
                            </button>
                          )}
                          <button className="icon-btn" onClick={() => setMedia(media.filter((x) => x.id !== m.id))} aria-label={`Remove ${m.fileName}`}>
                            <IconX size={12} />
                          </button>
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                  {uploads.map((u) => (
                    <div key={u.key} className="media-tile small uploading">
                      <span className="media-name">{u.name}</span>
                      {u.error ? (
                        <span className="error-text">
                          {u.error}{' '}
                          <button className="icon-btn" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label="Dismiss">
                            <IconX size={12} />
                          </button>
                        </span>
                      ) : (
                        <progress value={u.progress} max={1} />
                      )}
                    </div>
                  ))}
                </div>
                <div className="button-row">
                  <input ref={fileInput} type="file" accept="video/*,image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} aria-label="Upload files" />
                  <button className="btn btn-secondary btn-lg" onClick={() => fileInput.current?.click()}>
                    <IconPhotoPlus size={14} /> Upload
                  </button>
                  <button className="btn btn-secondary btn-lg" onClick={() => setLibrary(true)}>
                    From library
                  </button>
                </div>
              </div>
              <label className="field">
                Caption
                <textarea className="input textarea" rows={6} value={caption} onChange={(e) => setCaption(e.target.value)} aria-label="Caption" />
                {captionLimit != null && (
                  <span className={`hint${charCount(caption) > captionLimit ? ' error-text' : ''}`}>
                    {charCount(caption)}/{captionLimit}
                  </span>
                )}
              </label>
            </section>
          )}

          {selected.map((a) => {
            const t = targets[a.id];
            const set = (patch: Partial<TargetDraft>) => setTargets({ ...targets, [a.id]: { ...t, ...patch } });
            const mine = problems.filter((p) => p.accountId === a.id);
            return (
              <section key={a.id} className={`card target-card${locked.has(a.id) ? ' locked' : ''}`} aria-label={`${a.name} settings`}>
                <div className="target-head">
                  <AccountLabel account={a} showPlatform />
                  {locked.has(a.id) && <span className="hint">Already published; changes won’t affect it.</span>}
                </div>
                <label className="check-row">
                  <input type="checkbox" checked={t.caption != null} onChange={(e) => set({ caption: e.target.checked ? caption : null })} />
                  {a.platform === 'youtube' ? 'Use a different description' : 'Use a different caption'}
                </label>
                {t.caption != null && <textarea className="input textarea" rows={4} value={t.caption} onChange={(e) => set({ caption: e.target.value })} aria-label={`Caption for ${a.name}`} />}
                <PlatformOptions account={a} options={t.options} set={(options) => set({ options })} media={media} />
                {mine.map((p, i) => (
                  <div key={i} className="problem">
                    <PlatformIcon platform={a.platform} /> {p.message}
                  </div>
                ))}
              </section>
            );
          })}

          {client && (
            <section className="card">
              <div className="field">
                When
                <div className="segmented">
                  <button className={when === 'now' ? 'active' : ''} aria-pressed={when === 'now'} onClick={() => setWhen('now')}>
                    Now
                  </button>
                  <button className={when === 'later' ? 'active' : ''} aria-pressed={when === 'later'} onClick={() => setWhen('later')}>
                    Later
                  </button>
                </div>
                {when === 'later' && <input className="input when-input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Publish at" />}
              </div>
              {general.map((p, i) => (
                <div key={i} className="problem">
                  {p.message}
                </div>
              ))}
              <div className="button-row">
                <button className="btn btn-primary btn-lg" disabled={busy || problems.length > 0} onClick={() => void save('schedule')}>
                  {when === 'now' ? 'Post now' : 'Schedule'}
                </button>
                <button className="btn btn-secondary btn-lg" disabled={busy} onClick={() => void save('draft')}>
                  Save draft
                </button>
              </div>
              {problems.length > 0 && <p className="hint">Fix the issues above to post. Drafts can be saved any time.</p>}
            </section>
          )}
        </div>
      </div>
      {library && client && (
        <LibraryPicker
          clientId={client.id}
          exclude={media.map((m) => m.id)}
          onPick={(m) => {
            setMedia((list) => [...list, m]);
            setLibrary(false);
          }}
          onClose={() => setLibrary(false)}
        />
      )}
    </div>
  );
}
