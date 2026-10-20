import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SignInPanel from './SignInPanel';

describe('native browser sign-in', () => {
  it.each([true, false])('only offers the local form when dev auth is %s', (devAuth) => {
    const html = renderToStaticMarkup(
      <SignInPanel
        devAuth={devAuth} busy={false} name="" email=""
        onNameChange={() => {}} onEmailChange={() => {}}
        onDevSignIn={() => {}} onSignIn={() => {}} onCancelSignIn={() => {}}
        signInStatus={null}
      />,
    );
    expect(html.includes('aria-label="Local workspace sign-in"')).toBe(devAuth);
    expect(html.includes('Enter local workspace')).toBe(devAuth);
    expect(html).toContain('Continue with WorkOS');
  });

  it('offers the confirmation URL while waiting', () => {
    const html = renderToStaticMarkup(
      <SignInPanel
        devAuth={false}
        busy={false}
        name=""
        email=""
        onNameChange={() => {}}
        onEmailChange={() => {}}
        onDevSignIn={() => {}}
        onSignIn={() => {}}
        onCancelSignIn={() => {}}
        signInStatus={{
          state: 'waiting',
          code: 'ABCD-1234',
          detail: 'Finish in the browser.',
          confirmUrl: 'https://app.bettrcomms.com/confirm',
        }}
      />,
    );

    expect(html).toContain('Open sign-in page');
    expect(html).toContain('href="https://app.bettrcomms.com/confirm"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
