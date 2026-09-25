export interface Genre {
  id: string;
  name: string;
  description?: string;
}

export interface TitleSources {
  /** HLS master playlist — preferred. */
  hls?: string;
  /** Progressive MP4 fallback (also used by the local dev catalog). */
  mp4?: string;
}

export interface Title {
  id: string;
  title: string;
  genreIds: string[];
  description: string;
  /** Seconds. Used for the duration badge and resume percentages. */
  durationSec: number;
  year?: number;
  instructor?: string;
  level?: 'beginner' | 'intermediate' | 'advanced';
  tags?: string[];
  poster?: string;
  backdrop?: string;
  sources: TitleSources;
  /** Optional WebVTT subtitle track. */
  subtitles?: { label: string; srclang: string; src: string }[];
  featured?: boolean;
}

export interface Catalog {
  version: number;
  updatedAt: string;
  genres: Genre[];
  titles: Title[];
}

export interface SessionUser {
  username: string;
  name: string;
  roles: string[];
}

export interface Session {
  user: SessionUser;
  /** Epoch seconds at which media access stops working. */
  mediaAccessExpiresAt: number;
}

/**
 * Sign-in is a short conversation rather than one request, because the user
 * pool requires a second factor. Every step answers with one of these, and the
 * only one that carries a session is the last.
 */
export type LoginOutcome =
  | ({ status: 'authenticated' } & Session)
  /** An invited account still holding the temporary password it was emailed. */
  | { status: 'new_password_required'; challengeToken: string }
  /** No authenticator app enrolled yet; these are what it needs to enrol. */
  | {
      status: 'mfa_setup_required';
      challengeToken: string;
      secretCode: string;
      otpauthUri: string;
    }
  /** Enrolled, and owes a code. */
  | { status: 'mfa_required'; challengeToken: string };
