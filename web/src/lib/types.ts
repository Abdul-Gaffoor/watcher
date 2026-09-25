/**
 * A node in the library tree. `parentId` is null at the root, which is all it
 * takes to express shelves of different depths: Trading > Elliott Wave > a
 * named course > its classes, alongside Movies > Telugu > the films.
 */
export interface Collection {
  id: string;
  name: string;
  parentId: string | null;
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
  /** The single collection this title is filed under. */
  collectionId: string;
  description?: string;
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
  /** Bumped on every save, and what makes a concurrent edit detectable. */
  revision: number;
  updatedAt: string;
  collections: Collection[];
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
