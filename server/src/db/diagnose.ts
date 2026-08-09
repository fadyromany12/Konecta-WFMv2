/**
 * Why the database would not open, in words that name the fix.
 *
 * The 503 this feeds used to say "check PULSE_DATABASE_URL and that the
 * database is awake", which is true of every possible cause and therefore
 * helps with none of them. A wrong password, a paused project, an endpoint the
 * platform cannot route to and a certificate chain all produce the identical
 * message, and the only way to tell them apart is to go and read the platform
 * logs — which the person looking at the sign-in screen usually cannot do.
 *
 * Every branch below was a real dead end during this deployment.
 *
 * ## What must never appear in the output
 *
 * The connection string holds a password. Driver errors do not normally quote
 * it, but "do not normally" is not a guarantee worth making on an endpoint that
 * answers before anybody has signed in, so the message is filtered rather than
 * trusted. The *host* is withheld too — for a direct Supabase endpoint it
 * carries the project reference — and replaced with the one bit that is
 * actually diagnostic: whether the endpoint is a pooled one or a direct one.
 */

/** What kind of endpoint the connection string points at. */
export type EndpointKind = 'pooled' | 'direct' | 'local' | 'unknown';

export interface Diagnosis {
  /** One sentence naming the cause. */
  reason: string;
  /** What to do about it. */
  fix: string;
  /** The driver's own code, when it had one. Useful in a bug report. */
  code: string | null;
}

/**
 * Pooled endpoints are the ones a serverless platform can actually reach.
 *
 * Supabase publishes two: a *direct* one on `db.<ref>.supabase.co`, which
 * resolves to IPv6 only and is therefore unroutable from most serverless
 * runtimes, and a *pooled* one on `<region>.pooler.supabase.com`. Choosing the
 * first is the single most common way to get a connection that times out with
 * nothing whatsoever wrong with the credentials.
 */
export function endpointKind(connectionString: string | null): EndpointKind {
  if (!connectionString) return 'unknown';
  let host: string;
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  if (host.includes('pooler.') || host.includes('-pooler') || host.includes('pgbouncer')) {
    return 'pooled';
  }
  if (host.startsWith('db.') && host.endsWith('.supabase.co')) return 'direct';
  return 'unknown';
}

/**
 * What the endpoint's kind implies — *when the instance is deployed*.
 *
 * Every one of these is a statement about running somewhere else. A direct
 * Supabase endpoint is only unreachable because Vercel has no IPv6; localhost
 * is only wrong because there is no Postgres inside a serverless function.
 * On a developer's own machine both are ordinary and correct, so the note is
 * gated rather than always appended — the first version told anybody running
 * locally that their working connection string "cannot be right".
 */
const KIND_NOTE: Record<EndpointKind, string> = {
  pooled: 'The configured endpoint is a pooled one, which is the right kind for a serverless deployment.',
  direct:
    'The configured endpoint is a direct one. Supabase resolves those to IPv6 only, and Vercel functions ' +
    'cannot reach IPv6 — use the pooler endpoint instead.',
  local: 'The configured endpoint is on localhost, which nothing outside this machine can reach.',
  unknown: '',
};

/**
 * Turn whatever the driver threw into a cause and a fix.
 *
 * Postgres `SQLSTATE`s are checked before Node's socket errors, because a
 * connection that got far enough to be rejected by Postgres tells us more than
 * one that never opened.
 */
export function diagnose(
  error: unknown,
  kind: EndpointKind = 'unknown',
  deployed = !!process.env.VERCEL,
): Diagnosis {
  const code = codeOf(error);
  const message = messageOf(error);
  const note = deployed ? KIND_NOTE[kind] : '';
  const withNote = (fix: string) => (note ? `${fix} ${note}` : fix);

  // Supavisor, Supabase's pooler, rejects an unrecognised tenant with this
  // rather than a normal authentication failure. It almost always means the
  // username is missing its project suffix.
  if (/tenant or user not found/i.test(message)) {
    return {
      code,
      reason: 'The pooler did not recognise that user.',
      fix:
        'On a Supabase pooled endpoint the username must be postgres.<project-ref>, not plain postgres. ' +
        'Copy the string from Connect rather than editing one by hand.',
    };
  }

  switch (code) {
    case '28P01':
      return {
        code,
        reason: 'Postgres rejected the password.',
        fix:
          'The database is reachable, so only the credential is wrong. If the password was rotated, ' +
          'the connection string still holds the old one. Special characters must be percent-encoded.',
      };
    case '28000':
      return {
        code,
        reason: 'Postgres refused the connection for that user.',
        fix: 'Check the username, and that the role is allowed to connect from outside.',
      };
    case '3D000':
      return {
        code,
        reason: 'That database does not exist on the server.',
        fix: 'The path at the end of the connection string is the database name; on Supabase it is postgres.',
      };
    case '53300':
      return {
        code,
        reason: 'The database is out of connection slots.',
        fix:
          'Use the pooled endpoint rather than the direct one, and keep PULSE_DB_POOL at 1 on serverless. ' +
          'A stuck deployment holding connections open will also do this.',
      };
    case '57P03':
      return {
        code,
        reason: 'The database is starting up and not accepting connections yet.',
        fix: 'Wait for it to finish waking and try again. A paused free-tier project does this on first contact.',
      };
  }

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code,
        reason: 'The database hostname does not resolve.',
        fix: withNote('The host in the connection string is wrong or the project no longer exists.'),
      };
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return {
        code,
        reason: 'The hostname resolves but nothing answered.',
        fix: withNote(
          'Most often the project is paused — free-tier Supabase projects pause after a spell of inactivity ' +
            'and have to be resumed from the dashboard.',
        ),
      };
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return {
        code,
        reason: 'The database presented a certificate this process cannot verify.',
        fix:
          'Pulse does not verify hosted certificate chains by default, so this means PULSE_DB_SSL=verify is set ' +
          'without a CA available. Unset it.',
      };
  }

  if (/timeout/i.test(message) && /connect/i.test(message)) {
    return {
      code,
      reason: 'The connection attempt timed out.',
      fix: withNote('Usually a paused project or an endpoint the platform cannot route to.'),
    };
  }

  return {
    code,
    reason: 'The database could not be opened.',
    fix: withNote(safeMessage(message) || 'No further detail came back from the driver.'),
  };
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * A driver message with anything credential-shaped taken out.
 *
 * Deliberately blunt. This is the only branch that passes text we did not write
 * to an unauthenticated caller, so it strips whole URLs rather than trying to
 * excise the password from inside one, and drops anything that looks like a
 * `user:pass@host` pair on its own.
 */
export function safeMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection string]')
    .replace(/\b[^\s:@/]+:[^\s:@/]+@[^\s/]+/g, '[credentials]')
    .slice(0, 300);
}
