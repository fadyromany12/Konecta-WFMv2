import type { Response } from 'express';
import { db } from '../db/index.js';
import { placeholders, visibleUserIds, type UserRow } from './people.js';

/**
 * Live events.
 *
 * The dashboard used to poll every thirty seconds, which meant a supervisor
 * could be looking at a screen that was wrong for twenty-nine of them. An
 * advisor clocking on is a fact the server already knows the instant it
 * happens; this pushes it rather than waiting to be asked.
 *
 * Server-sent events rather than websockets: the traffic is one-directional
 * (the client already has a REST API for anything it wants to say back), SSE
 * reconnects on its own, and it survives proxies that would drop an upgrade.
 *
 * Scope note for the hosted deployment: this bus lives in one process. On a
 * platform that runs several instances, a client connected to instance A will
 * not see an event raised on instance B, so the client keeps its poll as a
 * floor rather than replacing it. That is a deliberate trade — the poll makes
 * the screen eventually right, the stream makes it usually instant.
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
  kind: EventKind;
  /** Who the event is *about* — used to decide who may see it. */
  subjectId: number;
  /** Short human sentence, already phrased for a notification list. */
  summary: string;
  /** Extra payload the client may use to refresh a specific screen. */
  detail?: Record<string, unknown>;
  /** Raised at, as a wall-clock stamp like everything else in the app. */
  at: string;
  /** Monotonic within the process, so a reconnecting client can pick up. */
  id: number;
}

interface Subscriber {
  userId: number;
  /** User ids this subscriber is allowed to hear about, resolved at connect. */
  audience: Set<number>;
  res: Response;
}

const subscribers = new Set<Subscriber>();

/** Small replay buffer so a reconnect inside a few seconds misses nothing. */
const recent: PulseEvent[] = [];
const RECENT_LIMIT = 100;

let sequence = 0;

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * Raise an event. Deliberately never throws: a broken notification must not be
 * able to fail the punch or approval that produced it.
 */
export function emit(
  kind: EventKind,
  subjectId: number,
  summary: string,
  detail?: Record<string, unknown>,
): void {
  try {
    const event: PulseEvent = { kind, subjectId, summary, detail, at: stamp(), id: ++sequence };

    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();

    const frame = `id: ${event.id}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of subscribers) {
      if (!subscriber.audience.has(subjectId)) continue;
      try {
        subscriber.res.write(frame);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  } catch (err) {
    console.error('Could not raise event:', err);
  }
}

/**
 * Attach a response as an SSE stream. Returns a teardown the route registers
 * against the request closing.
 */
export function subscribe(user: UserRow, res: Response, lastEventId: number): () => void {
  // Resolved once at connect: who this user is entitled to hear about. An
  // advisor hears only about themselves, whatever else is happening.
  const audience = new Set<number>(
    user.role === 'ADVISOR' ? [user.id] : [...visibleUserIds(user), user.id],
  );

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer by default, which defeats the whole thing.
    'x-accel-buffering': 'no',
  });
  // Tell the client how long to wait before reconnecting, and open the stream
  // with a comment so the browser fires `onopen` immediately.
  res.write('retry: 4000\n');
  res.write(': stream open\n\n');

  const subscriber: Subscriber = { userId: user.id, audience, res };
  subscribers.add(subscriber);

  // Replay anything missed across a brief disconnect.
  if (lastEventId > 0) {
    for (const event of recent) {
      if (event.id <= lastEventId || !audience.has(event.subjectId)) continue;
      res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  // A comment every twenty seconds keeps intermediaries from calling the
  // connection idle and closing it.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive ${Date.now()}\n\n`);
    } catch {
      subscribers.delete(subscriber);
    }
  }, 20000);

  return () => {
    clearInterval(heartbeat);
    subscribers.delete(subscriber);
  };
}

export function subscriberCount(): number {
  return subscribers.size;
}

// ------------------------------------------------------------ notifications

export interface Notification {
  id: number;
  subject: string;
  body: string;
  severity: string;
  read: boolean;
  createdAt: string;
}

/**
 * Durable notifications, as distinct from the live stream: a supervisor who was
 * not at their desk when the event fired still needs to find out.
 */
export function notify(userIds: number[], subject: string, body: string, severity = 'INFO'): void {
  if (userIds.length === 0) return;
  try {
    const insert = db.prepare(
      'INSERT INTO messages (user_id, subject, body, severity) VALUES (?, ?, ?, ?)',
    );
    const write = db.transaction((ids: number[]) => {
      for (const id of ids) insert.run(id, subject, body, severity);
    });
    write(userIds);
  } catch (err) {
    console.error('Could not store notification:', err);
  }
}

/** Everyone who supervises this person, for "who needs to know" decisions. */
export function supervisorsOf(userId: number): number[] {
  const rows = db
    .prepare(
      `SELECT m.id FROM users u JOIN users m ON m.id = u.manager_id
       WHERE u.id = ? AND m.status = 'ACTIVE'`,
    )
    .all(userId) as { id: number }[];
  const direct = rows.map((r) => r.id);
  if (direct.length === 0) return [];

  // Anyone acting as an alternate for those managers needs the same visibility.
  const alternates = db
    .prepare(
      `SELECT alternate_user_id AS id FROM alternates WHERE user_id IN (${placeholders(direct.length)})`,
    )
    .all(...direct) as { id: number }[];

  return [...new Set([...direct, ...alternates.map((a) => a.id)])];
}

export function listNotifications(userId: number, limit = 50): Notification[] {
  const rows = db
    .prepare(
      'SELECT id, subject, body, severity, read_flag, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(userId, limit) as {
    id: number;
    subject: string;
    body: string;
    severity: string;
    read_flag: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    body: r.body,
    severity: r.severity,
    read: r.read_flag === 1,
    createdAt: r.created_at,
  }));
}

export function markAllRead(userId: number): number {
  return db.prepare('UPDATE messages SET read_flag = 1 WHERE user_id = ? AND read_flag = 0').run(userId)
    .changes;
}
