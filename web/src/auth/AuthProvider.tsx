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
import { api, ApiError } from '../lib/api';
import type { Session, SessionUser } from '../lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: SessionUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Renew the CloudFront cookies this far before they lapse. */
const REFRESH_LEAD_SECONDS = 5 * 60;
const MIN_REFRESH_DELAY_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (refreshTimer.current !== undefined) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
    }
  }, []);

  /**
   * Signed cookies are deliberately short-lived, so keep them fresh in the
   * background. A viewer part-way through a long video should never be
   * interrupted by a 403 on the next segment.
   */
  const scheduleRefresh = useCallback(
    (session: Session) => {
      clearTimer();
      const secondsUntilRefresh = session.mediaAccessExpiresAt - Date.now() / 1000 - REFRESH_LEAD_SECONDS;
      const delayMs = Math.max(MIN_REFRESH_DELAY_MS, secondsUntilRefresh * 1000);
      refreshTimer.current = window.setTimeout(async () => {
        try {
          scheduleRefresh(await api.refreshMediaAccess());
        } catch {
          setStatus('anonymous');
          setUser(null);
        }
      }, delayMs);
    },
    [clearTimer],
  );

  const adopt = useCallback(
    (session: Session) => {
      setUser(session.user);
      setStatus('authenticated');
      scheduleRefresh(session);
    },
    [scheduleRefresh],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .session()
      .then((session) => {
        if (!cancelled) adopt(session);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!(error instanceof ApiError)) console.error('Session check failed', error);
        setStatus('anonymous');
        setUser(null);
      });
    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [adopt, clearTimer]);

  const login = useCallback(
    async (username: string, password: string) => {
      adopt(await api.login(username, password));
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    clearTimer();
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, [clearTimer]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout }),
    [status, user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
