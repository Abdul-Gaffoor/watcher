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
  /** Epoch seconds at which the CloudFront signed cookies stop working. */
  mediaAccessExpiresAt: number;
}
