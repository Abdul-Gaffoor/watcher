import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Spinner } from '../components/Spinner';
import type { LoginOutcome } from '../lib/types';

/**
 * Sign-in is a short conversation, not one form, because the user pool requires
 * a second factor. The server decides which step comes next and this only
 * renders it, so the order lives in one place rather than two.
 */
type Step =
  | { kind: 'credentials' }
  | { kind: 'new-password'; challengeToken: string }
  | { kind: 'mfa-setup'; challengeToken: string; secretCode: string; otpauthUri: string }
  | { kind: 'mfa'; challengeToken: string };

function stepFor(outcome: LoginOutcome): Step | null {
  switch (outcome.status) {
    case 'new_password_required':
      return { kind: 'new-password', challengeToken: outcome.challengeToken };
    case 'mfa_setup_required':
      return {
        kind: 'mfa-setup',
        challengeToken: outcome.challengeToken,
        secretCode: outcome.secretCode,
        otpauthUri: outcome.otpauthUri,
      };
    case 'mfa_required':
      return { kind: 'mfa', challengeToken: outcome.challengeToken };
    case 'authenticated':
      // The provider has already adopted the session; the redirect below fires.
      return null;
  }
}

export function LoginPage() {
  const { status, login, setNewPassword, confirmMfaSetup, submitMfaCode } = useAuth();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPasswordValue] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'loading') {
    return (
      <div className="page page--centered">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  /** One submit path for every step, so errors and spinners behave the same. */
  const run = (advance: () => Promise<LoginOutcome>) => async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const next = stepFor(await advance());
      if (next) {
        setStep(next);
        setCode('');
        setNewPasswordValue('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed');
      // Never keep a rejected secret in a field the viewer will retype over.
      setPassword('');
      setCode('');
    } finally {
      setSubmitting(false);
    }
  };

  const startOver = () => {
    setStep({ kind: 'credentials' });
    setError(null);
    setPassword('');
    setNewPasswordValue('');
    setCode('');
  };

  const codeField = (label: string, hint: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        type="text"
        name="one-time-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        required
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
      />
      <span className="field__hint">{hint}</span>
    </label>
  );

  const shell = (children: ReactNode, onSubmit: (event: FormEvent) => void) => (
    <main className="login">
      <form className="login__card" onSubmit={onSubmit}>
        <h1 className="login__brand">
          <span className="header__mark" aria-hidden="true" />
          Watcher
        </h1>
        {children}
        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );

  if (step.kind === 'new-password') {
    return shell(
      <>
        <p className="login__tagline">Choose a password to replace the temporary one.</p>

        <label className="field">
          <span className="field__label">New password</span>
          <input
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={12}
            value={newPassword}
            onChange={(event) => setNewPasswordValue(event.target.value)}
          />
          <span className="field__hint">
            At least 12 characters, with upper and lower case, a digit and a symbol.
          </span>
        </label>

        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Set password'}
        </button>
        <button className="button button--ghost" type="button" onClick={startOver}>
          Start again
        </button>
      </>,
      run(() => setNewPassword(step.challengeToken, newPassword)),
    );
  }

  if (step.kind === 'mfa-setup') {
    return shell(
      <>
        <p className="login__tagline">Set up your authenticator app to finish.</p>

        <ol className="login__steps">
          <li>
            Open your authenticator app and add an account, either by opening{' '}
            <a className="login__link" href={step.otpauthUri}>
              this enrolment link
            </a>{' '}
            on this device or by entering the key below by hand.
          </li>
          <li>
            <span className="field__label">Setup key</span>
            <code className="login__secret">{step.secretCode}</code>
          </li>
          <li>Enter the six-digit code it shows.</li>
        </ol>

        {codeField('Code from your app', 'Codes change every 30 seconds.')}

        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Verifying…' : 'Finish setup'}
        </button>
        <button className="button button--ghost" type="button" onClick={startOver}>
          Start again
        </button>
      </>,
      run(() => confirmMfaSetup(step.challengeToken, code)),
    );
  }

  if (step.kind === 'mfa') {
    return shell(
      <>
        <p className="login__tagline">Enter the code from your authenticator app.</p>

        {codeField('Six-digit code', 'Codes change every 30 seconds.')}

        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
        <button className="button button--ghost" type="button" onClick={startOver}>
          Start again
        </button>
      </>,
      run(() => submitMfaCode(step.challengeToken, code)),
    );
  }

  return shell(
    <>
      <p className="login__tagline">Trading masterclasses and cinema, in one place.</p>

      <label className="field">
        <span className="field__label">Username</span>
        <input
          type="text"
          name="username"
          autoComplete="username"
          required
          autoFocus
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <button className="button button--primary" type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="login__note">Access is invite-only. Contact your administrator for credentials.</p>
    </>,
    run(() => login(username.trim(), password)),
  );
}
