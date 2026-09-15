import type { Catalog, Session } from './types';

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
    request<Session>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
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
