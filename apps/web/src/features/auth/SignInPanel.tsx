import type { FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrandTile, Wordmark } from '@/components/brand-mark';
import type { DesktopSignInStatus } from '@/desktop';

/** Shown below the call stage until someone signs in. */
export default function SignInPanel({
  devAuth,
  busy,
  name,
  email,
  onNameChange,
  onEmailChange,
  onDevSignIn,
  onSignIn,
  onCancelSignIn,
  signInStatus,
}: {
  devAuth: boolean;
  busy: boolean;
  name: string;
  email: string;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onDevSignIn: (event: FormEvent) => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  /** Set only on a host that signs in through the system browser. */
  signInStatus: DesktopSignInStatus | null;
}) {
  const waiting = signInStatus?.state === 'waiting';
  return (
    <div
      id="signin"
      className="flex shrink-0 flex-col items-stretch justify-between gap-4 rounded-3xl bc-card bc-aurora px-5 py-5 min-[821px]:flex-row min-[821px]:flex-wrap min-[821px]:items-center min-[821px]:pb-6"
    >
      <div>
        <span aria-hidden="true" className="mb-3 flex items-center gap-2.5">
          <BrandTile className="size-12" />
          <Wordmark />
        </span>
        <strong className="block font-heading text-xl font-extrabold tracking-tight bc-gradient-text">Your people are one sign-in away.</strong>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Sign in securely to create rooms and invite your friends.
        </p>
      </div>
      {waiting ? (
        <div
          className="flex flex-col gap-1.5 min-[821px]:items-end"
          role="status"
          aria-live="polite"
        >
          <span className="text-xs text-muted-foreground">
            {signInStatus.detail}
          </span>
          {signInStatus.code && (
            <strong className="font-mono text-lg tracking-[0.18em]">
              {signInStatus.code}
            </strong>
          )}
          {signInStatus.confirmUrl && (
            <a
              className="text-xs underline underline-offset-2"
              href={signInStatus.confirmUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open sign-in page
            </a>
          )}
          <Button variant="secondary" onClick={onCancelSignIn}>
            Cancel sign-in
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 min-[821px]:items-end">
          <Button className="bc-glow" onClick={onSignIn}>
            Continue with WorkOS <ArrowRight size={17} />
          </Button>
          {signInStatus?.state === 'failed' && (
            <span className="text-xs text-destructive" role="alert">
              {signInStatus.detail}
            </span>
          )}
        </div>
      )}
      {devAuth && (
        <form
          className="grid w-full grid-cols-1 items-center gap-2.5 pb-2.5 min-[821px]:flex min-[821px]:flex-wrap"
          onSubmit={onDevSignIn}
        >
          <span className="my-1 text-[0.6875rem] text-muted-foreground min-[821px]:my-0 min-[821px]:shrink-0">
            Local development
          </span>
          <Input
            className="min-w-20 min-[821px]:flex-1"
            aria-label="Your name"
            placeholder="Your name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            required
          />
          <Input
            className="min-w-20 min-[821px]:flex-1"
            aria-label="Your email"
            type="email"
            placeholder="you@example.test"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            required
          />
          <Button type="submit" variant="secondary" disabled={busy}>
            Enter local workspace
          </Button>
        </form>
      )}
    </div>
  );
}
