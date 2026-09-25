import type { Catalog, LoginOutcome, Session } from './types';

/**
 * Everything is same-origin in production (one CloudFront distribution fronts
 * the SPA, `/api/*` -> Lambda and `/media/*` -> the private media bucket), so
 * cookies flow without any CORS configuration.
 */
const CATALOG_URL = '/media/catalog.json';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginOutcome>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  /** Replaces the temporary password an invited account is emailed. */
  setNewPassword: (challengeToken: string, password: string) =>
    request<LoginOutcome>('/api/login/new-password', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, password }),
    }),

  /** Confirms a freshly enrolled authenticator app is in sync. */
  confirmMfaSetup: (challengeToken: string, code: string) =>
    request<LoginOutcome>('/api/login/mfa-setup', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, code }),
    }),

  /** The ordinary second step once an app is enrolled. */
  submitMfaCode: (challengeToken: string, code: string) =>
    request<LoginOutcome>('/api/login/mfa', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, code }),
    }),

  logout: () => request<void>('/api/logout', { method: 'POST' }),

  session: () => request<Session>('/api/session'),

  /** Re-issues the CloudFront signed cookies without re-entering credentials. */
  refreshMediaAccess: () => request<Session>('/api/refresh', { method: 'POST' }),
};

/**
 * The catalog lives in the media bucket, so it is gated by the same signed
 * cookies as the video segments. A 403 means the cookies aged out mid-session:
 * refresh them once and retry before bouncing the user to the login screen.
 */
export async function fetchCatalog(): Promise<Catalog> {
  const load = async () => {
    const response = await fetch(CATALOG_URL, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiError('Could not load the catalog', response.status);
    return (await response.json()) as Catalog;
  };

  try {
    return await load();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
      await api.refreshMediaAccess();
      return load();
    }
    throw error;
  }
}

/**
 * The dashboard's API. Every one of these is refused by the server unless the
 * session carries the admin role, so hiding the dashboard in the interface is
 * a courtesy rather than the control.
 */
export const adminApi = {
  catalog: () => request<{ catalog: Catalog }>('/api/admin/catalog'),

  saveCatalog: (catalog: Catalog, baseRevision: number) =>
    request<{ catalog: Catalog }>('/api/admin/catalog', {
      method: 'PUT',
      body: JSON.stringify({ catalog, baseRevision }),
    }),

  /** Returns presigned URLs; the bytes themselves never come back through here. */
  signUpload: (payload: Record<string, unknown>) =>
    request<{
      key: string;
      mediaPath: string;
      url: string;
      urls: { partNumber: number; url: string }[];
    }>('/api/admin/uploads', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
