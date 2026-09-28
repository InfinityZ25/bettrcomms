import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SignInPanel from './SignInPanel';

describe('native browser sign-in', () => {
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
