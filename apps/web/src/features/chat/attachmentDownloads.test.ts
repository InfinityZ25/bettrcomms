import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '@/api';
import { setSessionIdentity } from '@/features/auth/sessionEvents';
import { downloadMessageAttachment } from './attachmentFiles';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  api: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  setSessionIdentity(null);
});

function environment() {
  const tab = { location: { href: 'about:blank' }, opener: {}, close: vi.fn() };
  const open = vi.fn(() => tab);
  vi.stubGlobal('window', { open });
  const controller = new AbortController();
  const onError = vi.fn();
  return {
    tab,
    open,
    controller,
    onError,
    options: { signal: controller.signal, onError },
  };
}

function blockedPopupEnvironment() {
  const result = environment();
  const open = vi.fn(() => null);
  vi.stubGlobal('window', { open });
  const link = {
    href: '',
    target: '',
    rel: '',
    referrerPolicy: '',
    download: '',
    click: vi.fn(),
    remove: vi.fn(),
  };
  const append = vi.fn();
  const createElement = vi.fn(() => link);
  vi.stubGlobal('document', { body: { append }, createElement });
  return { ...result, open, link, append, createElement };
}

describe('attachment download lifetime', () => {
  it('uses and removes a named download link when the waiting popup is blocked', async () => {
    const { open, link, append, createElement, controller, onError, options } =
      blockedPopupEnvironment();
    vi.mocked(api).mockResolvedValueOnce({
      url: 'https://storage.example.test/original.png?signature=authorized',
    });
    expect(
      await downloadMessageAttachment(
        'room',
        'file',
        'holiday photo.png',
        options,
      ),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(createElement).toHaveBeenCalledWith('a');
    expect(link).toMatchObject({
      href: 'https://storage.example.test/original.png?signature=authorized',
      download: 'holiday photo.png',
      target: '_blank',
      rel: 'noopener noreferrer',
      referrerPolicy: 'no-referrer',
    });
    expect(append).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    controller.abort();
    expect(link.click).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['navigation', 'account replacement'] as const)(
    'ignores a late download error after %s when the popup was blocked',
    async (change) => {
      setSessionIdentity('old-account');
      const { createElement, controller, onError, options } =
        blockedPopupEnvironment();
      let fail!: (error: Error) => void;
      vi.mocked(api).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      );
      const pending = downloadMessageAttachment(
        'room',
        'file',
        'picture.png',
        options,
      );
      if (change === 'navigation') controller.abort();
      else setSessionIdentity('new-account');
      fail(new Error('Late storage authorization failure'));
      expect(await pending).toBe(false);
      expect(createElement).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('closes the waiting popup on navigation and ignores a late successful response', async () => {
    const { tab, controller, onError, options } = environment();
    let finish!: (value: { url: string }) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = downloadMessageAttachment(
      'room',
      'file',
      'picture.png',
      options,
    );
    expect(api).toHaveBeenCalledWith(
      '/rooms/room/attachments/file?link=1',
      undefined,
      undefined,
      controller.signal,
    );
    controller.abort();
    expect(tab.close).toHaveBeenCalledOnce();
    finish({ url: 'https://storage.example.test/picture.png' });
    expect(await pending).toBe(false);
    expect(tab.location.href).toBe('about:blank');
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects a link issued for an account replaced before React unmounts the old view', async () => {
    setSessionIdentity('old-account');
    const { tab, onError, options } = environment();
    let finish!: (value: { url: string }) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = downloadMessageAttachment(
      'room',
      'file',
      'picture.png',
      options,
    );
    setSessionIdentity('new-account');
    finish({ url: 'https://storage.example.test/private-picture.png' });
    expect(await pending).toBe(false);
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.href).toBe('about:blank');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports revoked membership without navigating, and releases its abort listener after completion', async () => {
    const { tab, controller, onError, options } = environment();
    vi.mocked(api).mockRejectedValueOnce(
      new ApiRequestError('Room membership required', 403),
    );
    expect(
      await downloadMessageAttachment('room', 'file', 'picture.png', options),
    ).toBe(false);
    expect(onError).toHaveBeenCalledWith('Room membership required');
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.href).toBe('about:blank');
    controller.abort();
    expect(tab.close).toHaveBeenCalledOnce();
  });

  it('keeps a completed authorized download open after the conversation later closes', async () => {
    const { tab, controller, options } = environment();
    vi.mocked(api).mockResolvedValueOnce({
      url: 'https://storage.example.test/picture.png',
    });
    expect(
      await downloadMessageAttachment('room', 'file', 'picture.png', options),
    ).toBe(true);
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('https://storage.example.test/picture.png');
    controller.abort();
    expect(tab.close).not.toHaveBeenCalled();
  });
});
