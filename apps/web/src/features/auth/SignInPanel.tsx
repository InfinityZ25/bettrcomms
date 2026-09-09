import type { FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signInWithWorkOS } from './useSession';

/** Shown below the call stage until someone signs in. */
export default function SignInPanel({
  devAuth,
  busy,
  name,
  email,
  onNameChange,
  onEmailChange,
  onDevSignIn,
}: {
  devAuth: boolean;
  busy: boolean;
  name: string;
  email: string;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onDevSignIn: (event: FormEvent) => void;
}) {
  return (
    <div
      id="signin"
      className="flex shrink-0 flex-col items-stretch justify-between gap-4 border-t py-5 min-[821px]:flex-row min-[821px]:flex-wrap min-[821px]:items-center min-[821px]:pb-6"
    >
      <div>
        <strong className="text-sm">Your people are one sign-in away.</strong>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Sign in securely to create rooms and invite your friends.
        </p>
      </div>
      <Button onClick={signInWithWorkOS}>
        Continue with WorkOS <ArrowRight size={17} />
      </Button>
      {devAuth && (
        <form
          className="grid w-full grid-cols-1 items-center gap-2.5 pb-2.5 min-[821px]:flex min-[821px]:flex-wrap"
          onSubmit={onDevSignIn}
        >
          <span className="my-1 text-[0.65rem] text-muted-foreground min-[821px]:my-0 min-[821px]:shrink-0">
            Local development
          </span>
          <input
            className="min-w-20 min-[821px]:flex-1"
            aria-label="Your name"
            placeholder="Your name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            required
          />
          <input
            className="min-w-20 min-[821px]:flex-1"
            aria-label="Your email"
            type="email"
            placeholder="you@example.test"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            required
          />
          <Button variant="secondary" disabled={busy}>
            Enter local workspace
          </Button>
        </form>
      )}
    </div>
  );
}
