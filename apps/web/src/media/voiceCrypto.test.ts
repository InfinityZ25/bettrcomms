import { describe, expect, it } from 'vitest';
import { createVoiceKeyPair, VoiceCryptoSession } from './voiceCrypto';

describe('voice relay crypto', () => {
  it('derives directional keys, agrees on a verification code, and rejects replay', async () => {
    const [aliceKeys, bobKeys] = await Promise.all([
      createVoiceKeyPair(),
      createVoiceKeyPair(),
    ]);
    const [alice, bob] = await Promise.all([
      VoiceCryptoSession.create(
        'alice',
        'bob',
        'epoch-1',
        aliceKeys,
        bobKeys.publicKey,
      ),
      VoiceCryptoSession.create(
        'bob',
        'alice',
        'epoch-1',
        bobKeys,
        aliceKeys.publicKey,
      ),
    ]);
    const encrypted = await alice.encrypt(new Uint8Array([1, 2, 3, 4]));
    await expect(
      bob.decrypt(encrypted.sequence, encrypted.data),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    await expect(
      bob.decrypt(encrypted.sequence, encrypted.data),
    ).resolves.toBeNull();
    expect(alice.getVerificationCode()).toBe(bob.getVerificationCode());
    expect(alice.getVerificationCode()).toMatch(
      /^(?:[0-9a-f]{4}-){7}[0-9a-f]{4}$/,
    );
  });

  it('authenticates ciphertext, peer identities, epoch, and sequence', async () => {
    const [aliceKeys, bobKeys] = await Promise.all([
      createVoiceKeyPair(),
      createVoiceKeyPair(),
    ]);
    const alice = await VoiceCryptoSession.create(
      'alice',
      'bob',
      'epoch-1',
      aliceKeys,
      bobKeys.publicKey,
    );
    const bob = await VoiceCryptoSession.create(
      'bob',
      'alice',
      'epoch-1',
      bobKeys,
      aliceKeys.publicKey,
    );
    const encrypted = await alice.encrypt(new Uint8Array([9, 8, 7]));
    const raw = Uint8Array.from(atob(encrypted.data), (value) =>
      value.charCodeAt(0),
    );
    raw[raw.length - 1] ^= 1;
    const tampered = btoa(String.fromCharCode(...raw));
    await expect(
      bob.decrypt(encrypted.sequence, tampered),
    ).rejects.toBeDefined();

    const wrongEpoch = await VoiceCryptoSession.create(
      'bob',
      'alice',
      'epoch-2',
      bobKeys,
      aliceKeys.publicKey,
    );
    await expect(
      wrongEpoch.decrypt(encrypted.sequence, encrypted.data),
    ).rejects.toBeDefined();
    await expect(
      bob.decrypt(encrypted.sequence + 1, encrypted.data),
    ).rejects.toBeDefined();
  });

  it('rejects oversized plaintext and malformed remote keys', async () => {
    const pair = await createVoiceKeyPair();
    await expect(
      VoiceCryptoSession.create('alice', 'bob', 'epoch', pair, btoa('short')),
    ).rejects.toThrow('public key');
    const remote = await createVoiceKeyPair();
    const session = await VoiceCryptoSession.create(
      'alice',
      'bob',
      'epoch',
      pair,
      remote.publicKey,
    );
    await expect(session.encrypt(new Uint8Array(3001))).rejects.toThrow(
      'packet size',
    );
  });
});
