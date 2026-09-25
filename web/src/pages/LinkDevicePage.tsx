import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { deviceApi } from '../lib/api';
import type { PendingDevice } from '../lib/types';

/**
 * The screen on the phone: what is asking to be let in, and do you want it to.
 *
 * Deliberately not one tap from the scan. Approving a device is handing over a
 * full session, and the one thing that stops a stranger's television being
 * signed in as you is that you read the description and chose. So the code is
 * described before it is granted, and Approve is never the default action.
 */

type Phase =
  | { kind: 'asking' }
  | { kind: 'loading' }
  | { kind: 'confirm'; pending: PendingDevice }
  | { kind: 'done'; approved: boolean }
  | { kind: 'error'; message: string };

export function LinkDevicePage() {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(searchParams.get('code') ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [working, setWorking] = useState(false);

  const look = useCallback(async (raw: string) => {
    setPhase({ kind: 'loading' });
    try {
      setPhase({ kind: 'confirm', pending: await deviceApi.pending(raw) });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Could not read that code.' });
    }
  }, []);

  // A scanned link carries the code, so skip straight to describing it.
  useEffect(() => {
    const scanned = searchParams.get('code');
    if (scanned) void look(scanned);
  }, [searchParams, look]);

  const decide = async (approve: boolean) => {
    if (phase.kind !== 'confirm') return;
    setWorking(true);
    try {
      // The code the server just confirmed, not whatever is in the input: the
      // two can differ once somebody edits the box after looking one up.
      await deviceApi.decide(phase.pending.displayCode.replace(/[^A-Za-z0-9]/g, ''), approve);
      setPhase({ kind: 'done', approved: approve });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'That did not work.' });
    } finally {
      setWorking(false);
    }
  };

  if (phase.kind === 'loading') {
    return (
      <div className="page page--centered">
        <Spinner label="Checking that code" />
      </div>
    );
  }

  if (phase.kind === 'done') {
    return (
      <div className="page page--centered">
        <h1>{phase.approved ? 'That device is signed in' : 'Request declined'}</h1>
        <p className="pair__lead">
          {phase.approved
            ? 'It should be showing your library within a couple of seconds.'
            : 'Nothing was granted. The device will say it was declined.'}
        </p>
        <Link className="button button--primary" to="/">
          Back to the library
        </Link>
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="page page--centered">
        <h1>That code is not waiting</h1>
        {/* One message for unknown, used and expired alike: the server will not
            say which, so neither does this. */}
        <p className="form__error">{phase.message}</p>
        <p className="pair__lead">Codes last ten minutes and work once. Ask the device for a new one.</p>
        <button
          className="button button--primary"
          type="button"
          onClick={() => setPhase({ kind: 'asking' })}
        >
          Try another code
        </button>
      </div>
    );
  }

  if (phase.kind === 'confirm') {
    const { pending } = phase;
    return (
      <div className="page page--centered pair">
        <h1 className="pair__title">Approve this device?</h1>

        <dl className="pair__facts">
          <div>
            <dt>Device</dt>
            <dd>{pending.device}</dd>
          </div>
          <div>
            <dt>Asking from</dt>
            <dd>{pending.ip}</dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>{pending.displayCode}</dd>
          </div>
        </dl>

        <p className="pair__warn">
          Approving signs that device in as you, with everything you can see. Only approve a device
          you are looking at right now.
        </p>

        <div className="pair__actions">
          {/* Decline first, and the plain one: the safe answer should not be
              the one you have to go looking for. */}
          <button
            className="button button--hero-secondary"
            type="button"
            disabled={working}
            onClick={() => void decide(false)}
          >
            Decline
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={working}
            onClick={() => void decide(true)}
          >
            {working ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    );
  }

  // No code in the link: a television that could not show a scannable QR, or a
  // scanner that dropped the query string.
  return (
    <div className="page page--centered pair">
      <h1 className="pair__title">Enter the code</h1>
      <p className="pair__lead">It is on the screen of the device you are signing in.</p>

      <form
        className="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void look(code);
        }}
      >
        <label className="visually-hidden" htmlFor="pair-code">
          Pairing code
        </label>
        <input
          id="pair-code"
          className="pair__input"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="WXYZ-2345"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button className="button button--primary" type="submit">
          Continue
        </button>
      </form>
    </div>
  );
}
