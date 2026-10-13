import { useEffect, type ReactNode } from 'react';
import { IconAlertTriangle, IconBrandFacebook, IconBrandInstagram, IconBrandTiktok, IconBrandYoutube, IconX } from '@tabler/icons-react';
import type { Account, Platform, TargetStatus } from '../../shared/types';
import { PLATFORM_LABEL } from '../../shared/rules';

const ICONS = { instagram: IconBrandInstagram, facebook: IconBrandFacebook, youtube: IconBrandYoutube, tiktok: IconBrandTiktok };

export function PlatformIcon({ platform, size = 14 }: { platform: Platform; size?: number }) {
  const Icon = ICONS[platform];
  return <Icon size={size} className={`pf pf-${platform}`} aria-label={PLATFORM_LABEL[platform]} />;
}

export function Avatar({ account, size = 20 }: { account: Pick<Account, 'avatarUrl' | 'name' | 'platform'>; size?: number }) {
  return (
    <span className="acct-avatar" style={{ width: size, height: size }}>
      {account.avatarUrl ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span>{account.name.slice(0, 1).toUpperCase()}</span>}
      <span className="acct-avatar-pf">
        <PlatformIcon platform={account.platform} size={Math.max(10, size * 0.5)} />
      </span>
    </span>
  );
}

export function AccountLabel({ account, showPlatform }: { account: Account; showPlatform?: boolean }) {
  return (
    <span className="acct-label">
      {showPlatform && (
        <span className="pf-label">
          <PlatformIcon platform={account.platform} size={16} /> {PLATFORM_LABEL[account.platform]} ·
        </span>
      )}
      <Avatar account={account} />
      <span className="acct-name">{account.name}</span>
      {account.handle && <span className="acct-handle">{account.handle}</span>}
      {account.status === 'reconnect' && (
        <span className="badge badge-failed" title={account.statusDetail}>
          <IconAlertTriangle size={12} /> Reconnect
        </span>
      )}
    </span>
  );
}

export const STATUS_LABEL: Record<TargetStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status }: { status: TargetStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** One overall status for a post from its accounts' statuses. */
export function overallStatus(statuses: TargetStatus[]): TargetStatus {
  if (!statuses.length) return 'draft';
  for (const s of ['failed', 'publishing', 'scheduled', 'draft'] as TargetStatus[]) if (statuses.includes(s)) return s;
  return statuses.every((s) => s === 'cancelled') ? 'cancelled' : 'published';
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Notice({ kind = 'info', children, onClose }: { kind?: 'info' | 'error' | 'success'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label="Dismiss">
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

export function Topbar({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-actions">{children}</div>
    </div>
  );
}
