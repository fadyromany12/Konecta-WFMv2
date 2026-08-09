import { useState } from 'react';
import { useT } from '../i18n';
import { LocaleSwitch } from '../components/LocaleSwitch';
import { useSession } from '../state';
import { Banner, Button, Card } from '../components/ui';

const DEMO = [
  { email: 'youssef.adel@konecta.example', label: 'Team Leader — nights (3 day edit window)' },
  { email: 'nadia.farouk@konecta.example', label: 'Operations Manager (44 day edit window)' },
  { email: 'omar.hassan@konecta.example', label: 'Trainer (6 day edit window)' },
  { email: 'layla.mahmoud@konecta.example', label: 'Advisor — the interesting week' },
  { email: 'admin@konecta.example', label: 'System Administrator' },
];

export function Login() {
  const { signIn } = useSession();
  const t = useT();
  const [email, setEmail] = useState('youssef.adel@konecta.example');
  const [password, setPassword] = useState('pulse123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login">
        <div className="brand" style={{ justifyContent: 'center', marginBottom: '1rem' }}>
          <span className="brand-mark" style={{ fontSize: '1.6rem' }}>
            Konecta <span>Pulse</span>
          </span>
        </div>
        <p className="muted" style={{ textAlign: 'center', marginBottom: '1rem' }}>
          Planning · Utilization · Labor · Scheduling · Exceptions
        </p>

        <div className="login-locale">
          <LocaleSwitch />
        </div>

        <Card>
          {error && <Banner tone="error">{error}</Banner>}
          <form onSubmit={submit}>
            <label>
              {t('Email address')}
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              {t('Password')}
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? t('Signing in…') : t('Sign in')}
            </Button>
          </form>

          <div className="demo-accounts">
            <span className="muted">Demonstration accounts — password is pulse123</span>
            <ul>
              {DEMO.map((d) => (
                <li key={d.email}>
                  <button type="button" onClick={() => setEmail(d.email)}>
                    {d.email}
                  </button>{' '}
                  <span className="muted">{d.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <p className="muted" style={{ textAlign: 'center' }}>
          Your sign-in is yours alone. Every change you make is recorded against it.
        </p>
      </div>
    </div>
  );
}
