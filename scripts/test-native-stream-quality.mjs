// Opt-in Windows hardware acceptance. Captures only this script's synthetic
// window, decodes the real native RTP stream in Chromium, and probes native-copy MP4s.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const endpoint = process.env.BETTERCOMMS_NATIVE_CDP ?? 'http://127.0.0.1:9223';
const outputDir = '.local/capture-probe/stream-quality';
const host = await chromium.connectOverCDP(endpoint);
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-blink-features=RTCRtpScriptTransform'],
});
const source = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const receiver = await browser.newPage();
let app;
let sessionId;

const waitFor = async (probe, message, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
};

async function connectReceiver(peerId, offer, dropCapable) {
  const answer = await receiver.evaluate(async ({ peerId, offer, dropCapable }) => {
    const pc = new RTCPeerConnection();
    const video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.dataset.peer = peerId;
    document.body.append(video);
    let worker;
    pc.ontrack = event => {
      video.srcObject = new MediaStream([event.track]);
      void video.play();
      if (dropCapable) {
        const code = `let dropping=false;onmessage=e=>dropping=e.data==='drop';onrtctransform=e=>e.transformer.readable.pipeThrough(new TransformStream({transform(f,c){if(!dropping)c.enqueue(f)}})).pipeTo(e.transformer.writable);`;
        worker = new Worker(URL.createObjectURL(new Blob([code], {type:'text/javascript'})));
        event.receiver.transform = new RTCRtpScriptTransform(worker, { name: peerId });
      }
    };
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ICE gathering timeout')), 10_000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    window.qualityPeers ??= {};
    window.qualityPeers[peerId] = { pc, video, worker };
    return pc.localDescription.toJSON();
  }, { peerId, offer, dropCapable });
  await app.evaluate(({ sessionId, peerId, answer }) => window.__TAURI_INTERNALS__.invoke(
    'native_screen_peer_answer', { sessionId, peerId, description: answer },
  ), { sessionId, peerId, answer });
  return answer;
}

async function stats(peerId) {
  return receiver.evaluate(async peerId => {
    const { pc, video } = window.qualityPeers[peerId];
    const all = [...(await pc.getStats()).values()];
    const inbound = all.find(item => item.type === 'inbound-rtp' && item.kind === 'video');
    const transport = all.find(item => item.type === 'transport' && item.selectedCandidatePairId);
    const pair = all.find(item => item.id === transport?.selectedCandidatePairId);
    return {
      state: pc.connectionState,
      framesDecoded: inbound?.framesDecoded ?? 0,
      framesReceived: inbound?.framesReceived ?? 0,
      keyFramesDecoded: inbound?.keyFramesDecoded ?? 0,
      framesDropped: inbound?.framesDropped ?? 0,
      packetsReceived: inbound?.packetsReceived ?? 0,
      packetsLost: inbound?.packetsLost ?? 0,
      bytesReceived: inbound?.bytesReceived ?? 0,
      headerBytesReceived: inbound?.headerBytesReceived ?? 0,
      pliCount: inbound?.pliCount ?? 0,
      firCount: inbound?.firCount ?? 0,
      nackCount: inbound?.nackCount ?? 0,
      candidatePairState: pair?.state,
      width: inbound?.frameWidth ?? video.videoWidth,
      height: inbound?.frameHeight ?? video.videoHeight,
      codec: all.find(item => item.id === inbound?.codecId)?.mimeType,
    };
  }, peerId);
}

async function offerPeer(peerId, dropCapable = false) {
  const offer = await app.evaluate(({ sessionId, peerId }) => window.__TAURI_INTERNALS__.invoke(
    'native_screen_peer_offer', { sessionId, peerId, iceServers: [], directOnly: true },
  ), { sessionId, peerId });
  const answer = await connectReceiver(peerId, offer, dropCapable);
  const fmtp = sdp => (sdp ?? '').split(/\r?\n/).filter(line =>
    /^a=(rtpmap|fmtp):\d+\s?.*H264|^a=fmtp:\d+.*profile-level-id/i.test(line),
  );
  console.log('H264 SDP', JSON.stringify({ peerId, offer: fmtp(offer.sdp), answer: fmtp(answer.sdp) }));
}

async function removePeer(peerId) {
  await app.evaluate(({ sessionId, peerId }) => window.__TAURI_INTERNALS__.invoke(
    'native_screen_peer_remove', { sessionId, peerId },
  ), { sessionId, peerId }).catch(() => undefined);
  await receiver.evaluate(peerId => {
    const peer = window.qualityPeers?.[peerId];
    peer?.pc.close(); peer?.worker?.terminate(); peer?.video.remove();
    if (window.qualityPeers) delete window.qualityPeers[peerId];
  }, peerId);
}

async function saveRecording(label) {
  const recording = await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke(
    'native_screen_recording_start', { sessionId },
  ), sessionId);
  // The production GOP is 120 frames at 60 fps. Span more than one full GOP so
  // the native-copy recording always contains an IDR regardless of start phase.
  await new Promise(resolve => setTimeout(resolve, 2_500));
  const asset = await app.evaluate(recordingId => window.__TAURI_INTERNALS__.invoke(
    'native_screen_recording_stop', { recordingId },
  ), recording.recordingId);
  const chunks = [];
  for (let offset = 0; offset < asset.sizeBytes; offset += 256 * 1024) {
    const base64 = await app.evaluate(async ({ assetId, offset, maxBytes }) => {
      const values = await window.__TAURI_INTERNALS__.invoke(
        'native_screen_recording_read', { assetId, offset, maxBytes },
      );
      const blob = new Blob([values]);
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
    }, { assetId: asset.assetId, offset, maxBytes: Math.min(256 * 1024, asset.sizeBytes - offset) });
    chunks.push(Buffer.from(base64, 'base64'));
  }
  const path = `${outputDir}/${label}.mp4`;
  await writeFile(path, Buffer.concat(chunks));
  await app.evaluate(assetId => window.__TAURI_INTERNALS__.invoke(
    'native_screen_recording_release', { assetId },
  ), asset.assetId);
  return path;
}

try {
  await mkdir(outputDir, { recursive: true });
  app = host.contexts().flatMap(context => context.pages()).find(page => page.url().includes(':5173'));
  assert.ok(app, 'Native development preview must be open');
  await source.setContent(`<title>BetterComms Stream Quality Fixture</title><style>html,body,canvas{margin:0;width:100%;height:100%;overflow:hidden}</style><canvas width=1920 height=1080></canvas><script>const c=document.querySelector('canvas'),x=c.getContext('2d');function f(t){x.fillStyle='#102030';x.fillRect(0,0,1920,1080);x.fillStyle='#00d878';x.fillRect(0,0,960,1080);x.fillStyle='#df304f';x.fillRect(960,0,960,1080);x.fillStyle='white';x.font='64px sans-serif';x.fillText('Native 1080p60 · '+Math.floor(t/100),60,120);x.fillRect((t/3)%1800,500,120,120);requestAnimationFrame(f)}requestAnimationFrame(f)</script>`);
  await source.bringToFront();
  const caps = await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_screen_capabilities'));
  assert.ok(caps.available, caps.detail);
  const encoder = process.env.BETTERCOMMS_ENCODER ?? ['h264_nvenc', 'h264_amf', 'h264_qsv']
    .find(id => caps.encoders.find(item => item.id === id)?.available);
  assert.ok(encoder, 'A hardware H.264 encoder is required');
  const target = await waitFor(async () => {
    await source.bringToFront();
    const list = await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_screen_sources'));
    return list.sources.find(item => item.kind === 'window' && item.name.includes('BetterComms Stream Quality Fixture'));
  }, 'Controlled synthetic window was not enumerated');

  const supportsHigh = await receiver.evaluate(() =>
    RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec =>
      codec.mimeType.toLowerCase() === 'video/h264' && /profile-level-id=64/i.test(codec.sdpFmtpLine ?? ''),
    ) ?? false,
  );
  const requestedProfiles = process.env.BETTERCOMMS_PROFILES?.split(',').filter(Boolean);
  const profiles = requestedProfiles ?? (supportsHigh ? ['baseline', 'main', 'high'] : ['baseline', 'main']);
  const bitrates = process.env.BETTERCOMMS_BITRATES?.split(',').map(Number).filter(Number.isFinite) ?? [8, 12, 20];
  if (!supportsHigh) console.log('SKIP high profile: Chromium receiver does not advertise H.264 profile 6400');
  for (const profile of profiles) {
    for (const bitrateMbps of bitrates) {
      sessionId = (await app.evaluate(args => window.__TAURI_INTERNALS__.invoke(
        'native_screen_start', args,
      ), { sourceId: target.id, encoder, h264Profile: profile, width: 1920, height: 1080, fps: 60, bitrateMbps, cursor: false })).sessionId;
      const peerId = `${profile}-${bitrateMbps}`;
      const recoveryCase = (profile === 'baseline' || profile === 'main') && bitrateMbps === 8;
      await offerPeer(peerId, recoveryCase);
      let decoded;
      try {
        decoded = await waitFor(async () => {
          const value = await stats(peerId);
          return value.framesDecoded >= 120 ? value : null;
        }, `${peerId} did not decode 120 frames`);
      } catch (error) {
        console.error('DECODE FAILURE', peerId, JSON.stringify(await stats(peerId)));
        const failurePath = await saveRecording(`${encoder}-${profile}-${bitrateMbps}mbps-decode-failure`);
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,profile,level,width,height', '-of', 'json', failurePath]);
        console.error('FAILURE MP4', probe.stdout.trim());
        throw error;
      }
      assert.equal(decoded.codec, 'video/H264');
      assert.equal(decoded.width, 1920); assert.equal(decoded.height, 1080);

      if (recoveryCase) {
        const before = decoded.framesDecoded;
        const keyFramesBefore = decoded.keyFramesDecoded;
        await receiver.evaluate(peerId => window.qualityPeers[peerId].worker.postMessage('drop'), peerId);
        await new Promise(resolve => setTimeout(resolve, 800));
        await receiver.evaluate(peerId => {
          const peer = window.qualityPeers[peerId]; peer.worker.postMessage('pass');
          peer.pc.getReceivers().find(item => item.track?.kind === 'video')?.requestKeyFrame?.();
        }, peerId);
        const recovered = await waitFor(async () => {
          const value = await stats(peerId);
          return value.framesDecoded >= before + 60 ? value : null;
        }, 'Receiver did not recover after simulated encoded-frame loss');
        assert.ok(recovered.keyFramesDecoded > keyFramesBefore, 'Recovery must decode a new key frame');

        await new Promise(resolve => setTimeout(resolve, 750));
        await offerPeer('late-join');
        const late = await waitFor(async () => {
          const value = await stats('late-join');
          return value.framesDecoded >= 60 ? value : null;
        }, 'Late joiner did not receive a decodable periodic key frame');
        assert.equal(late.width, 1920); assert.equal(late.height, 1080);
        await removePeer('late-join');
      }

      let stream = { skipped: true };
      if (process.env.BETTERCOMMS_SKIP_RECORDING !== '1') {
        const path = await saveRecording(`${encoder}-${profile}-${bitrateMbps}mbps`);
        const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,profile,width,height', '-of', 'json', path]);
        stream = JSON.parse(stdout).streams[0];
        assert.equal(stream.codec_name, 'h264'); assert.equal(stream.width, 1920); assert.equal(stream.height, 1080);
        assert.match(stream.profile, profile === 'high' ? /^High/ : profile === 'main' ? /^Main/ : /Baseline/);
      }
      console.log('PASS', JSON.stringify({ encoder, profile, bitrateMbps, decoded, mp4: stream }));
      await removePeer(peerId);
      await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('native_screen_stop', { sessionId }), sessionId);
      sessionId = undefined;
    }
  }
} finally {
  if (sessionId && app) await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke(
    'native_screen_stop', { sessionId },
  ), sessionId).catch(() => undefined);
  await browser.close();
  await host.close();
}
