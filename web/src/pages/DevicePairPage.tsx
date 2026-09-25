import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { encode } from 'uqr';
import { useAuth } from '../auth/AuthProvider';
import { Spinner } from '../components/Spinner';
import { deviceApi } from '../lib/api';
import type { DevicePairing } from '../lib/types';

/**
 * The screen you sign in *from* — a television, or a laptop you would rather
 * not type a password into.
 *
 * It shows a code, waits, and becomes signed in when a phone says so. The
 * password is never typed here, never travels here, and is never seen by
 * whoever else is in the room.
 */

type Phase =
  | { kind: 'starting' }
  | { kind: 'waiting'; pairing: DevicePairing; expiresAt: number }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

/**
 * Drawn as one <path> of black squares on a white rect rather than a grid of
 * elements: a version-4 code is well over a thousand modules, and a thousand
 * DOM nodes on a television is a visibly slow render.
 *
 * White stays white in dark mode. A QR with an inverted quiet zone is a QR
 * that half the scanners in the world will not read.
 */
function QrCode({ text, label }: { text: string; label: string }) {
  const result = encode(text, { ecc: 'M', border: 2 });
  const size = result.size;

  let path = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (result.data[y][x]) path += `M${x} ${y}h1v1h-1z`;
    }
  }

  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function secondsLeft(expiresAt: number) {
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

export function DevicePairPage() {
  const { status, adoptSession } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [remaining, setRemaining] = useState(0);

  // Survives re-renders so a React strict-mode double mount cannot open two
  // pairings and leave one of them orphaned on screen.
  const started = useRef(false);

  const begin = useCallback(async () => {
    setPhase({ kind: 'starting' });
    try {
      const pairing = await deviceApi.start();
      setPhase({ kind: 'waiting', pairing, expiresAt: Date.now() + pairing.expiresInSeconds * 1000 });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Could not start.' });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
  }, [begin]);

  // The poll. A timeout chained after each response rather than an interval,
  // so a slow answer cannot stack requests on top of each other.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const outcome = await deviceApi.poll(phase.pairing.userCode, phase.pairing.deviceCode);
        if (cancelled) return;

        if (outcome.status === 'approved') {
          // The cookies arrived with this response; this just tells the app.
          adoptSession(outcome);
          return;
        }
        if (outcome.status === 'denied') return setPhase({ kind: 'denied' });
        if (outcome.status === 'expired') return setPhase({ kind: 'expired' });

        timer = window.setTimeout(tick, outcome.intervalSeconds * 1000);
      } catch (error) {
        if (cancelled) return;
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Lost contact.' });
      }
    };

    timer = window.setTimeout(tick, phase.pairing.intervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, adoptSession]);

  // The countdown, which is the honest way to say "this will stop working".
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const update = () => {
      const left = secondsLeft(phase.expiresAt);
      setRemaining(left);
      if (left === 0) setPhase({ kind: 'expired' });
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  if (phase.kind === 'starting') {
    return (
      <div className="page page--centered">
        <Spinner label="Preparing a code" />
      </div>
    );
  }

  if (phase.kind !== 'waiting') {
    const headline =
      phase.kind === 'denied' ? 'That request was declined'
      : phase.kind === 'expired' ? 'That code has expired'
      : 'Something went wrong';

    return (
      <div className="page page--centered">
        <h1>{headline}</h1>
        {phase.kind === 'error' && <p className="form__error">{phase.message}</p>}
        <button className="button button--primary" type="button" onClick={() => void begin()}>
          Show a new code
        </button>
        <Link className="pair__alt" to="/login">
          Use a password instead
        </Link>
      </div>
    );
  }

  const url = `${window.location.origin}/link?code=${phase.pairing.userCode}`;

  return (
    <div className="page page--centered pair">
      <h1 className="pair__title">Sign in with your phone</h1>
      <p className="pair__lead">
        Scan this with a phone that is already signed in, and approve the request.
      </p>

      <QrCode text={url} label={`Pairing code ${phase.pairing.displayCode}`} />

      <p className="pair__or">or go to {window.location.host}/link and enter</p>
      <p className="pair__code">{phase.pairing.displayCode}</p>

      <p className="pair__status">
        <Spinner label="Waiting for approval" />
      </p>
      <p className="pair__expiry">
        This code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
      </p>

      <Link className="pair__alt" to="/login">
        Use a password instead
      </Link>
    </div>
  );
}
