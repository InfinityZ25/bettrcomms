import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProfile, prepareProfileAvatar, profileValidation } from './profile';
import { clearProfiles, profileRevision, profileSnapshot, receiveProfile, reconcileProfile } from './profileStore';

afterEach(() => { clearProfiles(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('profile drafts', () => {
  it('normalizes public names while rejecting invalid usernames and long bios', () => {
    expect(normalizeProfile({ name: '  Jair  ', username: ' JAIR_123 ', bio: ' Hi ' })).toEqual({ name: 'Jair', username: 'jair_123', bio: 'Hi' });
    expect(profileValidation({ name: 'Jair', username: 'jair_123', bio: 'a'.repeat(160) })).toBe('');
    for (const username of ['ab', 'with space', 'Uppercase', 'dash-name', 'x'.repeat(33)]) expect(profileValidation({ name: 'Jair', username, bio: '' })).not.toBe('');
    expect(profileValidation({ name: 'Jair', username: 'jair', bio: '🙂'.repeat(161) })).toContain('description');
  });
  it('does not let an older profile request overwrite a live update', () => {
    const old = { id: 'user', name: 'Old', email: 'test@example.test' };
    receiveProfile(old);
    const revision = profileRevision('user');
    const live = { ...old, name: 'New', username: 'new_name' };
    receiveProfile(live);
    expect(reconcileProfile(old, revision)).toEqual(live);
    expect(profileSnapshot().user).toEqual(live);
  });
  it('bounds cached users and forgets them on session end', () => {
    for (let index = 0; index < 520; index++) receiveProfile({ id: String(index), name: 'Friend', email: '' });
    expect(Object.keys(profileSnapshot())).toHaveLength(512);
    clearProfiles();
    expect(profileSnapshot()).toEqual({});
  });
  it('rejects out-of-order profile events and accepts a newer mutation reply', () => {
    const profile = { id: 'user', name: 'Initial', email: '', profile_version: 1 };
    receiveProfile(profile);
    const revision = profileRevision('user');
    receiveProfile({ ...profile, name: 'Live update', profile_version: 3 });
    expect(receiveProfile({ ...profile, name: 'Older event', profile_version: 2 })?.name).toBe('Live update');
    expect(reconcileProfile({ ...profile, name: 'Newest response', profile_version: 4 }, revision).name).toBe('Newest response');
    expect(profileSnapshot().user.profile_version).toBe(4);
  });
});
describe('local avatar preparation', () => {
  it('rejects unsupported or oversized input before allocating an image', async () => {
    await expect(prepareProfileAvatar(new File(['x'], 'x.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG or JPEG');
    await expect(prepareProfileAvatar(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))).rejects.toThrow('2 MB');
  });
  it('releases the image URL and canvas after decoding fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:input');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const canvas = { width: 1, height: 1 };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) { if (value) queueMicrotask(() => this.onerror?.()); }
    });
    await expect(prepareProfileAvatar(new File(['x'], 'bad.png', { type: 'image/png' }))).rejects.toThrow('could not be opened');
    expect(revoke).toHaveBeenCalledWith('blob:input');
    expect(canvas).toEqual({ width: 0, height: 0 });
  });
  it('resizes once and sends a compressed image, retaining no temporary URL', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:input');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (done: (blob: Blob) => void) => done(new Blob(['jpeg'], { type: 'image/jpeg' })) };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('Image', class {
      naturalWidth = 1000; naturalHeight = 500;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    });
    const result = await prepareProfileAvatar(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 250, 0, 500, 500, 0, 0, 256, 256);
    expect(result.type).toBe('image/jpeg');
    expect(result.size).toBe(4);
    expect(revoke).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
  });
  it('cancels an unmounted image decode and releases its temporary URL', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:input');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
    vi.stubGlobal('Image', class { onload = null; onerror = null; src = ''; });
    const controller = new AbortController();
    const pending = prepareProfileAvatar(new File(['x'], 'photo.png', { type: 'image/png' }), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(revoke).toHaveBeenCalledWith('blob:input');
  });
});
