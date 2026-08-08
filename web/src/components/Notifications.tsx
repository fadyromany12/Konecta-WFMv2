import { useEffect, useRef, useState } from 'react';
import { relativeTime, useLive } from '../live';

/**
 * The notification centre.
 *
 * Distinct from toasts on purpose: a toast is for something *you* just did and
 * is allowed to disappear; this is for something *someone else* did and has to
 * still be here tomorrow morning. Both exist because a supervisor is not
 * looking at the screen at the moment an advisor clocks on late.
 */
export function NotificationBell() {
  const { notifications, unread, markAllRead, markRead, connected } = useLive();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Click anywhere else, or press Escape, and it goes away — a panel that traps
  // you is worse than no panel.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="bell-wrap" ref={panel}>
      <button
        className={`bell ${unread > 0 ? 'bell-unread' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        title={connected ? 'Live — updates arrive as they happen' : 'Updating periodically'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.6L4.4 16h15.2L18 12.6V9a6 6 0 0 0-6-6Zm0 18a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 21Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 9 ? '9+' : unread}</span>}
        <span className={`bell-live ${connected ? 'is-live' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <header className="notif-head">
            <div>
              <strong>Notifications</strong>
              <div className="muted">
                {connected ? 'Live' : 'Refreshing periodically'} · {unread} unread
              </div>
            </div>
            {unread > 0 && (
              <button className="btn btn-ghost" onClick={() => void markAllRead()}>
                Mark all read
              </button>
            )}
          </header>

          <div className="notif-list">
            {notifications.length === 0 && <p className="empty">Nothing has needed you yet.</p>}
            {notifications.map((n) => (
              <button
                key={n.id}
                className={`notif ${n.read ? '' : 'notif-unread'} notif-${n.severity.toLowerCase()}`}
                onClick={() => void markRead(n.id)}
              >
                <div className="notif-top">
                  <strong>{n.subject}</strong>
                  <span className="muted">{relativeTime(n.createdAt)}</span>
                </div>
                <div className="notif-body">{n.body}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
