import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type Catalog, type Group, type User } from './api';

interface Session {
  user: User | null;
  catalog: Catalog | null;
  groups: Group[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  refreshGroups: () => Promise<void>;
  /** Re-read the signed-in user, after they change something about themselves. */
  refreshUser: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  const loadContext = useCallback(async () => {
    const [cat, grp] = await Promise.all([
      api.get<Catalog>('/catalog'),
      api.get<{ groups: Group[] }>('/people/groups'),
    ]);
    setCatalog(cat);
    setGroups(grp.groups);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.get<{ user: User }>('/auth/me');
        if (cancelled) return;
        setUser(me.user);
        // An account that must change its password is refused everything else,
        // including the two calls below. Asking anyway would throw and drop
        // them back to the sign-in screen, where the same password would let
        // them in and the same thing would happen again.
        if (!me.user.mustChangePassword) await loadContext();
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadContext]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
      setToken(res.token);
      setUser(res.user);
      if (!res.user.mustChangePassword) await loadContext();
    },
    [loadContext],
  );

  const refreshUser = useCallback(async () => {
    const me = await api.get<{ user: User }>('/auth/me');
    setUser(me.user);
    // Everything the rest of the app needs was skipped while the account was
    // held at the password screen, so this is where it finally gets loaded.
    if (!me.user.mustChangePassword) await loadContext();
  }, [loadContext]);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setGroups([]);
    setCatalog(null);
  }, []);

  const refreshGroups = useCallback(async () => {
    const grp = await api.get<{ groups: Group[] }>('/people/groups');
    setGroups(grp.groups);
  }, []);

  const value = useMemo(
    () => ({ user, catalog, groups, loading, signIn, signOut, refreshGroups, refreshUser }),
    [user, catalog, groups, loading, signIn, signOut, refreshGroups, refreshUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}

/** Small async data hook with an explicit reload, used by every screen. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
