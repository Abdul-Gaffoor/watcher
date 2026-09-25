import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { Title } from '../lib/types';
import { PlayerControls } from './PlayerControls';

interface HlsPlayerProps {
  title: Title;
  /** Seconds to seek to once metadata is ready. */
  startAt?: number;
  onProgress?: (positionSec: number, durationSec: number) => void;
  onEnded?: () => void;
  /** Offered on the control bar and on the N key, when there is a next lesson. */
  onNext?: () => void;
  nextLabel?: string;
}

/** How long the chrome stays up after the pointer stops moving, while playing. */
const IDLE_MS = 2600;

/** Reports position at most this often so we are not writing on every frame. */
const PROGRESS_INTERVAL_MS = 5000;

export function HlsPlayer({ title, startAt = 0, onProgress, onEnded, onNext, nextLabel }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /**
   * The same two nodes as state, because the control bar subscribes to the
   * element's events and a ref does not re-render when it is filled in. Passing
   * ref.current would hand the controls null on first paint and only fix
   * itself if some later event happened to re-render this.
   */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  /**
   * Stable, because React re-runs a callback ref whose identity changed --
   * detaching with null and reattaching on every render. An inline arrow that
   * calls setState is therefore a render loop, not a convenience.
   */
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setVideoEl(node);
  }, []);

  const attachStage = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    setStageEl(node);
  }, []);
  const idleTimer = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [idle, setIdle] = useState(false);
  /** Rendered briefly after a skip, the way a television does it. */
  const [flash, setFlash] = useState<'back' | 'forward' | null>(null);
  const hlsSrc = title.sources.hls;
  const mp4Src = title.sources.mp4;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);

    let hls: Hls | undefined;
    let disposed = false;

    const seekToStart = () => {
      if (startAt > 0 && Number.isFinite(video.duration) && startAt < video.duration) {
        video.currentTime = startAt;
      }
    };
    video.addEventListener('loadedmetadata', seekToStart);

    const attach = async () => {
      // Safari and iOS play HLS natively, which is cheaper than shipping the
      // library; everyone else gets hls.js, loaded only on the watch page.
      const canPlayNatively = video.canPlayType('application/vnd.apple.mpegurl') !== '';

      if (hlsSrc && canPlayNatively) {
        video.src = hlsSrc;
        return;
      }

      if (hlsSrc) {
        const { default: HlsCtor } = await import('hls.js');
        if (disposed) return;

        if (HlsCtor.isSupported()) {
          hls = new HlsCtor({
            enableWorker: true,
            lowLatencyMode: false,
            // Segments are same-origin behind CloudFront; the signed cookies
            // must ride along with every segment request.
            xhrSetup: (xhr) => {
              xhr.withCredentials = true;
            },
          });
          hls.on(HlsCtor.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
              // Most often an expired signed cookie or a transient 5xx.
              hls?.startLoad();
              setError('Playback stalled — retrying. Reload the page if this persists.');
            } else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
              hls?.recoverMediaError();
            } else {
              setError('This video could not be played.');
              hls?.destroy();
            }
          });
          hls.loadSource(hlsSrc);
          hls.attachMedia(video);
          return;
        }
      }

      if (mp4Src) {
        video.src = mp4Src;
        return;
      }

      setError('No playable source is available for this title.');
    };

    void attach();

    return () => {
      disposed = true;
      video.removeEventListener('loadedmetadata', seekToStart);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [hlsSrc, mp4Src, startAt]);

  // Throttled progress reporting, plus a final flush when leaving the page.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onProgress) return;

    const report = () => {
      if (video.duration > 0) onProgress(video.currentTime, video.duration);
    };
    const interval = window.setInterval(report, PROGRESS_INTERVAL_MS);
    video.addEventListener('pause', report);
    window.addEventListener('pagehide', report);

    return () => {
      window.clearInterval(interval);
      video.removeEventListener('pause', report);
      window.removeEventListener('pagehide', report);
      report();
    };
  }, [onProgress]);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== undefined) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  // Chrome hides itself only while something is playing. A paused player with
  // the controls faded out is a player that looks broken.
  useEffect(() => {
    if (!playing) {
      setIdle(false);
      if (idleTimer.current !== undefined) window.clearTimeout(idleTimer.current);
      return;
    }
    wake();
    return () => {
      if (idleTimer.current !== undefined) window.clearTimeout(idleTimer.current);
    };
  }, [playing, wake]);

  const skip = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration);
    setFlash(seconds < 0 ? 'back' : 'forward');
    window.setTimeout(() => setFlash(null), 450);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  /**
   * The shortcuts anybody who watches video already knows. Bound to the stage
   * rather than the window so they cannot fire while a search box or an admin
   * field has focus.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const key = event.key.toLowerCase();

    const handled: Record<string, () => void> = {
      ' ': togglePlay,
      k: togglePlay,
      arrowright: () => skip(10),
      arrowleft: () => skip(-10),
      l: () => skip(10),
      j: () => skip(-10),
      m: () => {
        video.muted = !video.muted;
      },
      f: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void stageRef.current?.requestFullscreen?.().catch(() => undefined);
      },
      n: () => onNext?.(),
      arrowup: () => {
        video.volume = Math.min(1, video.volume + 0.1);
      },
      arrowdown: () => {
        video.volume = Math.max(0, video.volume - 0.1);
      },
    };

    const run = handled[key];
    if (!run) return;
    event.preventDefault();
    wake();
    run();
  };

  return (
    <div
      ref={attachStage}
      className="player"
      data-idle={idle && playing ? 'true' : undefined}
      data-playing={playing ? 'true' : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={wake}
      onPointerLeave={() => playing && setIdle(true)}
    >
      <video
        ref={attachVideo}
        className="player__video"
        playsInline
        preload="metadata"
        poster={title.backdrop ?? title.poster}
        crossOrigin="use-credentials"
        onClick={togglePlay}
        onDoubleClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void stageRef.current?.requestFullscreen?.().catch(() => undefined);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => {
          setWaiting(false);
          setReady(true);
        }}
        onLoadedData={() => setReady(true)}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
      >
        {(title.subtitles ?? []).map((track) => (
          <track key={track.srclang} kind="subtitles" label={track.label} srcLang={track.srclang} src={track.src} />
        ))}
      </video>

      {/* A wash under the chrome rather than over the whole frame, so the
          picture stays the brightest thing on the page. */}
      <div className="player__shade" aria-hidden="true" />

      {waiting && <span className="player__buffer" aria-label="Buffering" />}

      {flash && <span className={`player__flash player__flash--${flash}`} aria-hidden="true" />}

      {!playing && !error && (
        <button className="player__big-play" type="button" onClick={togglePlay} aria-label="Play">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </button>
      )}

      <PlayerControls
        video={videoEl}
        stage={stageEl}
        onNext={onNext}
        nextLabel={nextLabel}
        hasSubtitles={(title.subtitles ?? []).length > 0}
      />

      {error && (
        <p className="player__error" role="alert">
          {error}
        </p>
      )}
      {/* Referenced so the ready flag is not merely written; it keeps the
          poster up until there is a real frame behind it. */}
      <span className="visually-hidden">{ready ? 'Video ready' : 'Loading video'}</span>
    </div>
  );
}
