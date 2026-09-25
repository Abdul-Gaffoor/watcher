import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatClock } from '../lib/format';
import { isFullscreen, toggleFullscreen, watchFullscreen } from './fullscreen';

/**
 * The control bar.
 *
 * Native controls are the browser's, not the product's: they look different in
 * every browser, they cannot carry "next lesson", and on a course they cannot
 * say which lesson this is. These can.
 *
 * Everything here reads from the video element rather than from React state.
 * The element is the source of truth -- it is also driven by the keyboard, by
 * the OS media keys and by a picture-in-picture window -- so the bar subscribes
 * to its events instead of trying to own its position.
 */

interface Props {
  video: HTMLVideoElement | null;
  /** The surface to fullscreen, so the controls come with it. */
  stage: HTMLElement | null;
  onNext?: () => void;
  nextLabel?: string;
  hasSubtitles: boolean;
}

const SKIP_SECONDS = 10;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function Icon({ path, filled = true }: { path: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export function PlayerControls({ video, stage, onNext, nextLabel, hasSubtitles }: Props) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [subsOn, setSubsOn] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);

  // One subscription for everything the element can tell us.
  useEffect(() => {
    if (!video) return;

    const sync = () => {
      setPlaying(!video.paused && !video.ended);
      setTime(video.currentTime);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setVolume(video.volume);
      setMuted(video.muted);
      setRate(video.playbackRate);
      const ranges = video.buffered;
      setBuffered(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
    };

    const events = [
      'play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata',
      'progress', 'volumechange', 'ratechange', 'seeked',
    ];
    events.forEach((name) => video.addEventListener(name, sync));
    sync();

    return () => events.forEach((name) => video.removeEventListener(name, sync));
  }, [video]);

  // iOS fires its own events on the video and never fires fullscreenchange, so
  // watching the document alone leaves this icon wrong for the whole time the
  // video is full screen.
  useEffect(() => watchFullscreen(video, () => setFullscreen(isFullscreen(video))), [video]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (!video || !Number.isFinite(video.duration)) return;
      video.currentTime = Math.min(Math.max(0, seconds), video.duration);
    },
    [video],
  );

  /** Pointer position along the bar, as a fraction. Shared by click and drag. */
  const fractionAt = useCallback((clientX: number) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const box = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  }, []);

  const startScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    seekTo(fractionAt(event.clientX) * duration);
  };

  const moveScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing || !duration) return;
    seekTo(fractionAt(event.clientX) * duration);
  };

  const endScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setScrubbing(false);
  };

  const cycleSpeed = () => {
    if (!video) return;
    const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length] ?? 1;
    video.playbackRate = next;
  };

  const toggleSubs = () => {
    if (!video) return;
    const tracks = video.textTracks;
    const turningOn = !subsOn;
    for (let i = 0; i < tracks.length; i += 1) tracks[i].mode = turningOn ? 'showing' : 'disabled';
    setSubsOn(turningOn);
  };

  const played = duration > 0 ? (time / duration) * 100 : 0;
  const loaded = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div className="pc" data-scrubbing={scrubbing || undefined}>
      <div
        ref={barRef}
        className="pc__bar"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
        onPointerDown={startScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') seekTo(time + SKIP_SECONDS);
          if (event.key === 'ArrowLeft') seekTo(time - SKIP_SECONDS);
        }}
      >
        <span className="pc__track" />
        {/* What has downloaded, so a stall is legible rather than mysterious. */}
        <span className="pc__loaded" style={{ width: `${loaded}%` }} />
        <span className="pc__played" style={{ width: `${played}%` }} />
        <span className="pc__knob" style={{ left: `${played}%` }} />
      </div>

      <div className="pc__row">
        <button
          className="pc__button pc__button--play"
          type="button"
          onClick={() => (video?.paused ? void video.play() : video?.pause())}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon path={playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5.5v13l11-6.5z'} />
        </button>

        <button
          className="pc__button"
          type="button"
          onClick={() => seekTo(time - SKIP_SECONDS)}
          aria-label={`Back ${SKIP_SECONDS} seconds`}
        >
          <Icon filled={false} path="M11 7 6 12l5 5M6 12h7a5 5 0 1 1 0 10" />
        </button>

        <button
          className="pc__button"
          type="button"
          onClick={() => seekTo(time + SKIP_SECONDS)}
          aria-label={`Forward ${SKIP_SECONDS} seconds`}
        >
          <Icon filled={false} path="m13 7 5 5-5 5M18 12h-7a5 5 0 1 0 0 10" />
        </button>

        {onNext && (
          <button className="pc__button" type="button" onClick={onNext} aria-label={nextLabel ?? 'Next lesson'}>
            <Icon path="M6 5.5v13l9-6.5zM16 5h2.5v14H16z" />
          </button>
        )}

        <span className="pc__time">
          {formatClock(time)} <span className="pc__time-sep">/</span> {formatClock(duration)}
        </span>

        <span className="pc__spacer" />

        <div className="pc__volume">
          <button
            className="pc__button"
            type="button"
            onClick={() => video && (video.muted = !video.muted)}
            aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
          >
            <Icon
              path={
                muted || volume === 0
                  ? 'M4 9h3l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6'
                  : 'M4 9h3l5-4v14l-5-4H4zM16 8a5 5 0 0 1 0 8'
              }
              filled={false}
            />
          </button>
          <input
            className="pc__slider"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(event) => {
              if (!video) return;
              video.volume = Number(event.target.value);
              video.muted = Number(event.target.value) === 0;
            }}
          />
        </div>

        <button className="pc__button pc__button--text" type="button" onClick={cycleSpeed} aria-label="Playback speed">
          {rate}&times;
        </button>

        {hasSubtitles && (
          <button
            className={subsOn ? 'pc__button is-on' : 'pc__button'}
            type="button"
            onClick={toggleSubs}
            aria-pressed={subsOn}
            aria-label="Subtitles"
          >
            <Icon filled={false} path="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM7 12h4M13 12h4M7 15.5h3M12 15.5h5" />
          </button>
        )}

        <button
          className="pc__button"
          type="button"
          onClick={() => toggleFullscreen(stage, video)}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          <Icon
            filled={false}
            path={
              fullscreen
                ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
                : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
            }
          />
        </button>
      </div>
    </div>
  );
}
