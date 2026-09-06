const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(
  value: string,
  maxLength = 512,
): Uint8Array<ArrayBuffer> {
  if (value.length > maxLength)
    throw new Error('Voice relay data is too large');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function context(
  from: string,
  to: string,
  epoch: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(`bettercomms/voice-relay/v1\0${from}\0${to}\0${epoch}`);
}

function aad(
  from: string,
  to: string,
  epoch: string,
  sequence: number,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    `bettercomms/voice-relay/v1\0${from}\0${to}\0${epoch}\0${sequence}`,
  );
}

function nonce(prefix: Uint8Array, sequence: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('Voice relay sequence is invalid');
  const value = new Uint8Array(12);
  value.set(prefix.subarray(0, 4));
  new DataView(value.buffer).setBigUint64(4, BigInt(sequence), false);
  return value;
}

export interface VoiceKeyPair {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function createVoiceKeyPair(): Promise<VoiceKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    ),
  };
}

export class VoiceCryptoSession {
  private sendSequence = 0;
  private receivedSequence = -1;

  private constructor(
    readonly epoch: string,
    private readonly localPeerId: string,
    private readonly remotePeerId: string,
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    private readonly sendNoncePrefix: Uint8Array,
    private readonly receiveNoncePrefix: Uint8Array,
    private readonly verificationCode: string,
  ) {}

  static async create(
    localPeerId: string,
    remotePeerId: string,
    epoch: string,
    local: VoiceKeyPair,
    remotePublicKey: string,
  ): Promise<VoiceCryptoSession> {
    if (!localPeerId || !remotePeerId || localPeerId === remotePeerId)
      throw new Error('Voice relay peer identity is invalid');
    if (!epoch || epoch.length > 64)
      throw new Error('Voice relay epoch is invalid');
    const remoteRaw = base64ToBytes(remotePublicKey);
    if (remoteRaw.length !== 65 || remoteRaw[0] !== 4)
      throw new Error('Voice relay public key is invalid');
    const remote = await crypto.subtle.importKey(
      'raw',
      remoteRaw.buffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const secret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: remote },
      local.privateKey,
      256,
    );
    const material = await crypto.subtle.importKey(
      'raw',
      secret,
      'HKDF',
      false,
      ['deriveKey', 'deriveBits'],
    );
    const salt = await crypto.subtle.digest('SHA-256', encoder.encode(epoch));
    const deriveKey = (from: string, to: string) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: context(from, to, epoch) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    const derivePrefix = async (from: string, to: string) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: encoder.encode(`nonce\0${from}\0${to}\0${epoch}`),
          },
          material,
          32,
        ),
      );
    const [sendKey, receiveKey, sendPrefix, receivePrefix] = await Promise.all([
      deriveKey(localPeerId, remotePeerId),
      deriveKey(remotePeerId, localPeerId),
      derivePrefix(localPeerId, remotePeerId),
      derivePrefix(remotePeerId, localPeerId),
    ]);
    const transcript = [local.publicKey, remotePublicKey].sort().join('\0');
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(
          `${epoch}\0${[localPeerId, remotePeerId].sort().join('\0')}\0${transcript}`,
        ),
      ),
    );
    const verificationCode = Array.from(digest.subarray(0, 16), (byte) =>
      byte.toString(16).padStart(2, '0'),
    )
      .join('')
      .match(/.{1,4}/g)!
      .join('-');
    return new VoiceCryptoSession(
      epoch,
      localPeerId,
      remotePeerId,
      sendKey,
      receiveKey,
      sendPrefix,
      receivePrefix,
      verificationCode,
    );
  }

  async encrypt(
    packet: Uint8Array,
  ): Promise<{ sequence: number; data: string }> {
    if (packet.byteLength === 0 || packet.byteLength > 3000)
      throw new Error('Voice relay packet size is invalid');
    const sequence = this.sendSequence++;
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce(this.sendNoncePrefix, sequence),
        additionalData: aad(
          this.localPeerId,
          this.remotePeerId,
          this.epoch,
          sequence,
        ),
        tagLength: 128,
      },
      this.sendKey,
      Uint8Array.from(packet),
    );
    return { sequence, data: bytesToBase64(new Uint8Array(encrypted)) };
  }

  async decrypt(sequence: number, data: string): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(sequence) || sequence <= this.receivedSequence)
      return null;
    if (!data || data.length > 4096)
      throw new Error('Voice relay packet is too large');
    const encrypted = base64ToBytes(data, 4096);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce(this.receiveNoncePrefix, sequence),
        additionalData: aad(
          this.remotePeerId,
          this.localPeerId,
          this.epoch,
          sequence,
        ),
        tagLength: 128,
      },
      this.receiveKey,
      encrypted.buffer,
    );
    if (sequence <= this.receivedSequence) return null;
    this.receivedSequence = sequence;
    return new Uint8Array(decrypted);
  }

  getVerificationCode(): string {
    return this.verificationCode;
  }
}
