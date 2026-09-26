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

/**
 * A note lives in the same tree as the videos. It is a separate list rather
 * than a kind of title because almost nothing they carry is the same: a note
 * has no duration, no poster and no playback position.
 */
export interface Note {
  id: string;
  title: string;
  collectionId: string;
  /** What is stored, which is not always what was uploaded: .docx becomes html. */
  format: 'md' | 'html' | 'pdf';
  source: string;
  /** The uploaded file, when it differs from what is rendered. For download. */
  original?: string;
  originalName?: string;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface Catalog {
  version: number;
  /** Bumped on every save, and what makes a concurrent edit detectable. */
  revision: number;
  updatedAt: string;
  collections: Collection[];
  titles: Title[];
  notes: Note[];
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

/** What a device gets when it opens a pairing. */
export interface DevicePairing {
  /** Eight characters, unformatted. What the poll and the link carry. */
  userCode: string;
  /** The same code with a dash, which is what a person reads. */
  displayCode: string;
  /** The device's secret. Never displayed, never in the QR. */
  deviceCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DevicePollOutcome =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | ({ status: 'approved' } & Session);

/** What the approving phone is shown before it decides. */
export interface PendingDevice {
  displayCode: string;
  device: string;
  ip: string;
  requestedAt: string;
  expiresAt: string;
}
