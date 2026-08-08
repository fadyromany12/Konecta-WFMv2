import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken } from './api';
import { useSession } from './state';

/**
 * The live connection.
 *
 * Screens used to poll. Polling is fine for a report and wrong for a live
 * board: the whole claim of an intraday screen is that it is current, and a
 * thirty second poll means it is wrong most of the time. This opens one
 * server-sent event stream for the whole app and lets any screen subscribe to
 * the kinds of event it cares about.
 *
 * The poll is not removed, only slowed. The stream can fail for reasons the app
 * cannot see — a proxy that buffers, a serverless instance that is not the one
 * holding the event — so every screen that matters keeps a slow refresh as a
 * floor. The stream makes it instant; the poll makes it eventually right.
 */

export type EventKind =
  | 'punch'
  | 'timecard.approved'
  | 'timecard.saved'
  | 'schedule.changed'
  | 'swap.changed'
  | 'extra-hours.changed'
  | 'message';

export interface PulseEvent {
  id: number;
  kind: EventKind;
  subjectId: number;
  summary: string;
  detail?: Record<string, unknown>;
  at: string;
}

export interface Notification {
  id: number;
  subject: string;
  body: string;
  severity: string;
  read: boolean;
  createdAt: string;
}

type Handler = (event: PulseEvent) => void;

interface LiveApi {
  /** True while the event stream is open. False means the app is on its poll. */
  connected: boolean;
  /** The most recent event, for a screen that only wants "something changed". */
  latest: PulseEvent | null;
  notifications: Notification[];
  unread: number;
  markAllRead: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
  refreshNotifications: () => void;
  subscribe: (kinds: EventKind[] | '*', handler: Handler) => () => void;
}

const LiveContext = createContext<LiveApi | null>(null);

/** Give up on the stream after this many consecutive failures and just poll. */
const MAX_RETRIES = 4;

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<PulseEvent | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Handlers live in a ref so an event does not re-render every subscriber's
  // parent, and so subscribing does not tear down the connection.
  const handlers = useRef(new Set<{ kinds: EventKind[] | '*'; fn: Handler }>());

  const subscribe = useCallback((kinds: EventKind[] | '*', fn: Handler) => {
    const entry = { kinds, fn };
    handlers.current.add(entry);
    return () => {
      handlers.current.delete(entry);
    };
  }, []);

  const refreshNotifications = useCallback(() => {
    api
      .get<{ notifications: Notification[] }>('/notifications')
      .then((res) => setNotifications(res.notifications))
      .catch(() => {
        /* A missing notification list is not worth interrupting anyone over. */
      });
  }, []);

  // ------------------------------------------------------------ the stream
  useEffect(() => {
    if (!user) {
      setConnected(false);
      setNotifications([]);
      return;
    }

    const token = getToken();
    if (!token || typeof EventSource === 'undefined') return;

    let source: EventSource | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lastId = 0;

    function receive(raw: MessageEvent) {
      retries = 0;
      let event: PulseEvent;
      try {
        event = JSON.parse(raw.data);
      } catch {
        return;
      }
      lastId = Math.max(lastId, event.id);
      setLatest(event);
      for (const { kinds, fn } of handlers.current) {
        if (kinds === '*' || kinds.includes(event.kind)) {
          try {
            fn(event);
          } catch (err) {
            console.error('A live event handler threw:', err);
          }
        }
      }
    }

    function open() {
      if (closed) return;
      // The token travels in the query string because EventSource cannot set
      // headers. The server accepts it only on this one read-only route.
      source = new EventSource(`/api/events?token=${encodeURIComponent(token!)}&lastEventId=${lastId}`);

      source.onopen = () => {
        retries = 0;
        setConnected(true);
      };

      // Every named event kind arrives as its own type, plus the default.
      const kinds: EventKind[] = [
        'punch',
        'timecard.approved',
        'timecard.saved',
        'schedule.changed',
        'swap.changed',
        'extra-hours.changed',
        'message',
      ];
      for (const kind of kinds) source.addEventListener(kind, receive as EventListener);
      source.onmessage = receive;

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (closed) return;
        retries += 1;
        if (retries > MAX_RETRIES) {
          // Something structural is wrong with the stream. Stop hammering it;
          // every screen still has its poll.
          console.warn('Live updates are unavailable — falling back to periodic refresh.');
          return;
        }
        retryTimer = setTimeout(open, Math.min(30000, 2000 * 2 ** (retries - 1)));
      };
    }

    open();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [user]);

  // ----------------------------------------------------- notification list
  useEffect(() => {
    if (!user) return;
    refreshNotifications();
    // A slow poll so the badge is right even when the stream is not running.
    const timer = setInterval(refreshNotifications, 120000);
    return () => clearInterval(timer);
  }, [user, refreshNotifications]);

  // Anything at all happening is a reason to re-read the list: the server may
  // have written a message alongside the event.
  useEffect(() => {
    if (!latest) return;
    const timer = setTimeout(refreshNotifications, 400);
    return () => clearTimeout(timer);
  }, [latest, refreshNotifications]);

  const markRead = useCallback(async (id: number) => {
    setNotifications((current) => current.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await api.post(`/notifications/${id}/read`);
    } catch {
      /* The optimistic tick is not worth rolling back for. */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications((current) => current.map((n) => ({ ...n, read: true })));
    try {
      await api.post('/notifications/read-all');
    } catch {
      refreshNotifications();
    }
  }, [refreshNotifications]);

  const value = useMemo<LiveApi>(
    () => ({
      connected,
      latest,
      notifications,
      unread: notifications.filter((n) => !n.read).length,
      markAllRead,
      markRead,
      refreshNotifications,
      subscribe,
    }),
    [connected, latest, notifications, markAllRead, markRead, refreshNotifications, subscribe],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveApi {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside a LiveProvider');
  return ctx;
}

/**
 * Run something when one of these event kinds arrives. The handler is held in a
 * ref, so a screen can pass an inline closure without re-subscribing on every
 * render.
 */
export function useLiveEvent(kinds: EventKind[] | '*', handler: Handler): void {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(
    () => subscribe(kinds, (event) => ref.current(event)),
    // Kinds are a literal at every call site; stringify to keep the identity
    // stable without asking every caller to memoise an array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribe, Array.isArray(kinds) ? kinds.join(',') : kinds],
  );
}

/** Small formatter shared by the notification list and the live badge. */
export function relativeTime(stamp: string): string {
  const then = new Date(stamp.replace(' ', 'T') + (stamp.length <= 19 ? 'Z' : ''));
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return stamp;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
