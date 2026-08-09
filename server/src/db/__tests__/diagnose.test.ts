import { describe, expect, it } from 'vitest';
import { diagnose, endpointKind, safeMessage } from '../diagnose.js';

const err = (code: string, message = '') => Object.assign(new Error(message), { code });

describe('which endpoint we were pointed at', () => {
  it('recognises a Supabase pooler', () => {
    expect(endpointKind('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toBe(
      'pooled',
    );
  });

  it('recognises a direct Supabase endpoint', () => {
    // The one that resolves to IPv6 only and is therefore unroutable from a
    // Vercel function — the most common way to get a timeout with perfectly
    // good credentials.
    expect(endpointKind('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres')).toBe('direct');
  });

  it('recognises localhost', () => {
    expect(endpointKind('postgresql://u:p@127.0.0.1:5432/pulse')).toBe('local');
  });

  it('does not guess at an unfamiliar host', () => {
    expect(endpointKind('postgresql://u:p@db.example.com:5432/pulse')).toBe('unknown');
  });

  it('survives a connection string that will not parse', () => {
    expect(endpointKind('not a url')).toBe('unknown');
    expect(endpointKind(null)).toBe('unknown');
  });
});

describe('naming the cause', () => {
  it('calls a rejected password a rejected password', () => {
    const d = diagnose(err('28P01', 'password authentication failed for user "postgres"'));
    expect(d.reason).toContain('rejected the password');
    expect(d.fix).toContain('rotated');
  });

  it('points a pooler tenant error at the username format', () => {
    // Supavisor's wording, and it never means what it appears to mean.
    const d = diagnose(new Error('Tenant or user not found'));
    expect(d.fix).toContain('postgres.<project-ref>');
  });

  it('reads a timeout as a paused project', () => {
    expect(diagnose(err('ETIMEDOUT')).fix).toContain('paused');
  });

  it('tells a direct endpoint that it is the problem', () => {
    const d = diagnose(err('ETIMEDOUT'), 'direct', true);
    expect(d.fix).toContain('IPv6');
    expect(d.fix).toContain('pooler');
  });

  it('does not blame the endpoint when it is already the right kind', () => {
    const d = diagnose(err('ETIMEDOUT'), 'pooled', true);
    expect(d.fix).not.toContain('IPv6');
    expect(d.fix).toContain('right kind');
  });

  it('does not blame the endpoint for a credential failure', () => {
    // The connection got far enough to be rejected by Postgres, so routing is
    // demonstrably fine and mentioning it would send somebody the wrong way.
    const d = diagnose(err('28P01'), 'direct', true);
    expect(d.fix).not.toContain('IPv6');
  });

  it('says nothing about the endpoint when not deployed', () => {
    // Running against localhost on your own machine is ordinary and correct.
    // The first version told anybody doing it that their working connection
    // string could not be right.
    const d = diagnose(err('ECONNREFUSED'), 'local', false);
    expect(d.fix).not.toContain('reach');
    expect(diagnose(err('ETIMEDOUT'), 'direct', false).fix).not.toContain('IPv6');
  });

  it('recognises a certificate it cannot verify', () => {
    expect(diagnose(err('SELF_SIGNED_CERT_IN_CHAIN')).fix).toContain('PULSE_DB_SSL');
  });

  it('recognises a database that is still waking', () => {
    expect(diagnose(err('57P03')).reason).toContain('starting up');
  });

  it('recognises exhausted connection slots', () => {
    expect(diagnose(err('53300')).fix).toContain('PULSE_DB_POOL');
  });

  it('keeps the driver code for a bug report', () => {
    expect(diagnose(err('28P01')).code).toBe('28P01');
    expect(diagnose(new Error('who knows')).code).toBe(null);
  });

  it('still says something useful for an error it has never seen', () => {
    const d = diagnose(new Error('everything is on fire'));
    expect(d.reason).toBeTruthy();
    expect(d.fix).toContain('everything is on fire');
  });

  it('survives being handed something that is not an error', () => {
    expect(diagnose(null).reason).toBeTruthy();
    expect(diagnose('a string').reason).toBeTruthy();
    expect(diagnose(undefined).code).toBe(null);
  });
});

describe('never leaking the credential', () => {
  // This response is served before anybody has signed in, so a driver message
  // that happens to quote the connection string would publish the password.
  it('strips a whole connection string', () => {
    const message = 'connect failed for postgresql://postgres.abc:hunter2@host:6543/postgres';
    expect(safeMessage(message)).not.toContain('hunter2');
    expect(safeMessage(message)).toContain('[connection string]');
  });

  it('strips a bare user:password@host pair', () => {
    expect(safeMessage('auth failed for postgres.abc:hunter2@aws-0.pooler.supabase.com')).not.toContain(
      'hunter2',
    );
  });

  it('strips it through the whole diagnosis, not just the helper', () => {
    const d = diagnose(new Error('bad: postgresql://u:s3cr3t@h:5432/db'));
    expect(JSON.stringify(d)).not.toContain('s3cr3t');
  });

  it('leaves an innocent message alone', () => {
    expect(safeMessage('connection terminated unexpectedly')).toBe(
      'connection terminated unexpectedly',
    );
  });

  it('caps how much driver text it will repeat', () => {
    expect(safeMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(300);
  });
});
