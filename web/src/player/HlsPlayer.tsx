import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { Title } from '../lib/types';

interface HlsPlayerProps {
  title: Title;
  /** Seconds to seek to once metadata is ready. */
  startAt?: number;
  onProgress?: (positionSec: number, durationSec: number) => void;
  onEnded?: () => void;
}

/** Reports position at most this often so we are not writing on every frame. */
const PROGRESS_INTERVAL_MS = 5000;

export function HlsPlayer({ title, startAt = 0, onProgress, onEnded }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="player">
      <video
        ref={videoRef}
        className="player__video"
        controls
        playsInline
        preload="metadata"
        poster={title.backdrop ?? title.poster}
        crossOrigin="use-credentials"
        onEnded={onEnded}
      >
        {(title.subtitles ?? []).map((track) => (
          <track key={track.srclang} kind="subtitles" label={track.label} srcLang={track.srclang} src={track.src} />
        ))}
      </video>
      {error && (
        <p className="player__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
