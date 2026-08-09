/**
 * Choosing a password.
 *
 * Serves two situations with one screen. Somebody who has just been handed a
 * temporary password cannot get past this; somebody changing a password they
 * already chose reaches it from their own menu. The difference is the wording
 * and whether there is a way out, not the form.
 *
 * The rules are stated up front rather than revealed by rejection. A person
 * typing into a box that will refuse them for a reason they have not been told
 * is the most irritating five seconds in any application, and the fix costs one
 * sentence.
 */

import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../state';
import { useT } from '../i18n';
import { useToast } from '../components/Toast';
import { Banner, Button, Card, Toolbar } from '../components/ui';

export function ChangePassword({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { user, refreshUser } = useSession();
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Checked here as well as on the server because it is the one problem the
  // browser can answer instantly, and a round trip to be told you typed it
  // differently twice is a round trip too many.
  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setSaving(true);
    setProblems([]);
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next });
      toast.success(t('Password changed.'), t('It takes effect now, everywhere you sign in.'));
      await refreshUser();
      onDone?.();
    } catch (err) {
      const body = (err as { body?: { problems?: string[] } }).body;
      if (body?.problems?.length) setProblems(body.problems);
      else setProblems([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  }

  // Forced, this is the whole page — there is no application chrome behind it,
  // so it borrows the sign-in screen's shell, which is already built to sit on
  // the aurora backdrop. In-app it is one card among others on an ordinary
  // screen. Same form either way; only the frame changes.
  const body = (
    <>
      {forced && (
          <Banner tone="warn">
            {t('You signed in with a password somebody issued to you. Choose one of your own before going any further — nothing else will work until you do.')}
          </Banner>
        )}

        <p className="muted">
          {t('At least 10 characters. A short phrase of a few words is stronger than a short word with symbols in it, and much easier to type on a shift. It must not contain your own name, email address or employee ID.')}
        </p>

        <form onSubmit={submit} className="stack">
          <label>
            <span>{forced ? t('The password you were given') : t('Current password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            <span>{t('New password')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label>
            <span>{t('New password again')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              aria-invalid={mismatch}
            />
          </label>

          {mismatch && <p className="field-error">{t('Those two do not match.')}</p>}

          {problems.length > 0 && (
            <ul className="problem-list">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <Toolbar>
            <Button type="submit" variant="primary" disabled={saving || mismatch || !next}>
              {saving ? t('Saving…') : t('Set my password')}
            </Button>
            {!forced && onDone && (
              <Button type="button" onClick={onDone}>
                {t('Cancel')}
              </Button>
            )}
          </Toolbar>
        </form>

      {forced && (
        <p className="muted small">
          {t('Signed in as {email}. If that is not you, sign out and start again.', { email: user?.email ?? '' })}
        </p>
      )}
    </>
  );

  if (!forced) return <Card title={t('Change your password')}>{body}</Card>;

  return (
    <div className="login-wrap">
      <div className="login gate">
        <div className="brand" style={{ justifyContent: 'center', marginBottom: '1rem' }}>
          <span className="brand-mark" style={{ fontSize: '1.6rem' }}>
            Konecta <span>Pulse</span>
          </span>
        </div>
        <h2 className="gate-title">{t('Choose your own password')}</h2>
        {body}
      </div>
    </div>
  );
}
