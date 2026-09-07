// Opt-in Windows hardware acceptance. Captures only this script's synthetic
// window and connects the actual native H.264 RTP sender to Chromium.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const width = Number(process.env.BETTERCOMMS_TEST_WIDTH ?? 1280);
const height = Number(process.env.BETTERCOMMS_TEST_HEIGHT ?? 720);
const fps = Number(process.env.BETTERCOMMS_TEST_FPS ?? 60);
const bitrateMbps = Number(process.env.BETTERCOMMS_TEST_BITRATE_MBPS ?? 20);
const endpoint = process.env.BETTERCOMMS_NATIVE_CDP ?? 'http://127.0.0.1:9223';
assert.ok(Number.isInteger(width) && width > 0, 'Test width must be a positive integer');
assert.ok(Number.isInteger(height) && height > 0, 'Test height must be a positive integer');
assert.ok(Number.isInteger(fps) && fps >= 15 && fps <= 240, 'Test FPS must be 15–240');
assert.ok(Number.isInteger(bitrateMbps) && bitrateMbps >= 1 && bitrateMbps <= 200, 'Test bitrate must be 1–200 Mbps');

const host = await chromium.connectOverCDP(endpoint);
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--autoplay-policy=no-user-gesture-required'] });
const source = await browser.newPage({ viewport: { width, height } });
const receiver = await browser.newPage();
let app, session;
try {
  app = host.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':5173'));
  assert.ok(app, 'Native development preview must be open');
  await source.setContent(`<title>BetterComms Synthetic Capture Acceptance</title><style>body{margin:0;background:#101820;color:white;font:48px sans-serif}canvas{width:100vw;height:100vh}</style><canvas></canvas><script>const c=document.querySelector("canvas");c.width=${width};c.height=${height};const x=c.getContext("2d");function f(t){x.fillStyle="#102030";x.fillRect(0,0,c.width,c.height);x.fillStyle="#00e080";x.fillRect(0,0,c.width/2,c.height);x.fillStyle="#e03050";x.fillRect(c.width/2,0,c.width/2,c.height);x.fillStyle="white";x.font="48px sans-serif";x.fillText("Native capture · "+Math.floor(t/100),40,100);x.fillRect((t/4)%(c.width-80),Math.min(300,c.height-80),80,80);requestAnimationFrame(f)}requestAnimationFrame(f)</script>`);
  await source.bringToFront();
  const exportProbe = await app.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('recording_export_begin', { fileName: 'probe.webm', sizeBytes: -1 }); return 'unexpected success'; }
    catch (e) { return String(e); }
  });
  assert.ok(!exportProbe.includes('not found'), 'Current host must register recording_export_begin');
  const caps = await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_screen_capabilities'));
  assert.ok(caps.available, caps.detail);
  for (const encoder of ['h264_nvenc', 'h264_amf']) {
    if (!caps.encoders.find(e => e.id === encoder)?.available) continue;
    let target;
    for (let i=0;i<20&&!target;i++) {
      await source.bringToFront();
      const sources = await app.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_screen_sources'));
      target = sources.sources.find(s => s.kind === 'window' && s.name.includes('BetterComms Synthetic Capture Acceptance'));
      if(!target) await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(target, 'Only the synthetic test window is eligible for capture');
    session = await app.evaluate(args => window.__TAURI_INTERNALS__.invoke('native_screen_start', args), { sourceId: target.id, encoder, width, height, fps, bitrateMbps, cursor: false });
    const offer = await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('native_screen_peer_offer', { sessionId, peerId: 'acceptance', iceServers: [], directOnly: true }), session.sessionId);
    const answer = await receiver.evaluate(async offer => {
      const pc = window.testPc = new RTCPeerConnection();
      const video = window.testVideo = document.createElement('video'); video.muted = true; video.autoplay = true; document.body.append(video);
      pc.ontrack = e => { video.srcObject = new MediaStream([e.track]); void video.play(); };
      await pc.setRemoteDescription(offer); await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ICE gathering timeout')), 10000);
        pc.onicegatheringstatechange = () => { if(pc.iceGatheringState === 'complete'){clearTimeout(t);resolve();} };
      });
      return pc.localDescription.toJSON();
    }, offer);
    await app.evaluate(({ sessionId, description }) => window.__TAURI_INTERNALS__.invoke('native_screen_peer_answer', { sessionId, peerId: 'acceptance', description }), { sessionId: session.sessionId, description: answer });
    let decoded=false;
    for(let i=0;i<80&&!decoded;i++){
      decoded=await receiver.evaluate(async()=>[...(await window.testPc.getStats()).values()].some(s=>s.type==='inbound-rtp'&&s.framesDecoded>120));
      if(!decoded) await new Promise(r=>setTimeout(r,250));
    }
    if(!decoded) console.log(await receiver.evaluate(async()=>({state:window.testPc.connectionState,stats:[...(await window.testPc.getStats()).values()].filter(s=>s.type==='inbound-rtp').map(s=>({type:s.type,framesDecoded:s.framesDecoded,bytes:s.bytesReceived,packets:s.packetsReceived}))})));
    assert.ok(decoded,'Native H.264 must decode at least 120 frames');
    const stats = await receiver.evaluate(async () => {
      const all = [...(await window.testPc.getStats()).values()];
      const s = all.find(s => s.type === 'inbound-rtp' && s.framesDecoded !== undefined);
      const c=document.createElement('canvas');c.width=window.testVideo.videoWidth;c.height=window.testVideo.videoHeight;
      const x=c.getContext('2d');x.drawImage(window.testVideo,0,0);
      const green=[...x.getImageData(c.width*.25,c.height*.7,1,1).data];
      const red=[...x.getImageData(c.width*.75,c.height*.7,1,1).data];
      return { framesDecoded: s.framesDecoded, width:s.frameWidth,height:s.frameHeight,fps:s.framesPerSecond,bytes:s.bytesReceived,codec:all.find(c=>c.id===s.codecId)?.mimeType,green,red };
    });
    assert.equal(stats.width,width);assert.equal(stats.height,height);assert.equal(stats.codec,'video/H264');
    const rateStart = await receiver.evaluate(async () => {
      const s = [...(await window.testPc.getStats()).values()].find(s => s.type === 'inbound-rtp' && s.framesDecoded !== undefined);
      return { frames: s.framesDecoded, time: performance.now() };
    });
    await new Promise(r=>setTimeout(r,3000));
    const measuredFps = await receiver.evaluate(start => {
      return window.testPc.getStats().then(report => {
        const s = [...report.values()].find(s => s.type === 'inbound-rtp' && s.framesDecoded !== undefined);
        return (s.framesDecoded - start.frames) * 1000 / (performance.now() - start.time);
      });
    }, rateStart);
    if (fps > 60) assert.ok(measuredFps > 60, `Requested ${fps} FPS but decoded only ${measuredFps.toFixed(1)} FPS`);
    assert.ok(stats.green[1]>120&&stats.green[0]<80&&stats.red[0]>100&&stats.red[1]<120,'Decoded pixels must match the selected synthetic window');
    console.log(encoder, JSON.stringify({...stats, requestedFps:fps, measuredFps:Number(measuredFps.toFixed(1)), bitrateMbps}));
    // Record the exact sender stream through the native remuxer.
    const recording = await app.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('native_screen_recording_start', {sessionId}),session.sessionId);
    await new Promise(r=>setTimeout(r,2500));
    const asset = await app.evaluate(recordingId => window.__TAURI_INTERNALS__.invoke('native_screen_recording_stop',{recordingId}),recording.recordingId);
    const chunks=[];
    for(let offset=0;offset<asset.sizeBytes;offset+=256*1024){
      const base64 = await app.evaluate(async ({assetId,offset,maxBytes})=>{
        const bytes=await window.__TAURI_INTERNALS__.invoke('native_screen_recording_read',{assetId,offset,maxBytes});
        const blob=new Blob([bytes]);
        return await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(blob);});
      },{assetId:asset.assetId,offset,maxBytes:Math.min(256*1024,asset.sizeBytes-offset)});
      chunks.push(Buffer.from(base64,'base64'));
    }
    await writeFile(`.local/capture-probe/acceptance-${encoder}.mp4`,Buffer.concat(chunks));
    await app.evaluate(assetId=>window.__TAURI_INTERNALS__.invoke('native_screen_recording_release',{assetId}),asset.assetId);
    await app.evaluate(sessionId=>window.__TAURI_INTERNALS__.invoke('native_screen_stop',{sessionId}),session.sessionId);
    session=undefined;
    await receiver.evaluate(()=>{window.testPc.close();window.testVideo.remove();});
    console.log('PASS',encoder,'native capture, H.264 browser decode, MP4 remux, stop');
  }
  await source.bringToFront();
  const exported = await app.evaluate(async ({width,height,fps,bitrateMbps}) => {
    const {NativeScreenTransport,nativeScreenSessionForTrack}=await import('/src/media/nativeScreen.ts');
    const {TrackRecordingSession}=await import('/src/media/recording.ts');
    const sources=await window.__TAURI_INTERNALS__.invoke('native_screen_sources');
    const target=sources.sources.find(s=>s.name.includes('BetterComms Synthetic Capture Acceptance'));
    if(!target) throw new Error('Synthetic source missing');
    let track;
    const errors=[];
    const transport=new NativeScreenTransport({localPeerId:'test',send:async()=>{}},[],true,t=>track=t,()=>{},()=>{},e=>errors.push(e));
    try {
      await transport.start({sourceId:target.id,encoder:'h264_nvenc',width,height,fps,bitrateMbps,cursor:false});
      if(!track || !nativeScreenSessionForTrack(track)) throw new Error('Native preview recording registration missing');
      const recording=new TrackRecordingSession();recording.start([{peerId:'test',source:'screen',track}]);
      // Native recordings begin at the next IDR. Allow a full two-second GOP
      // plus enough media to verify a useful duration at every supported rate.
      await new Promise(r=>setTimeout(r,4500));
      const result=await recording.stop();
      const file=result.files.find(f=>f.name.endsWith('.mp4'));
      if(!file || result.manifest.tracks[0].status!=='complete') throw new Error(JSON.stringify(result.manifest.tracks));
      const base64=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file.blob);});
      return {base64,manifest:result.manifest.tracks[0],errors};
    } finally { await transport.stop();transport.dispose(); }
  }, {width,height,fps,bitrateMbps});
  assert.equal(exported.manifest.mimeType,'video/mp4');
  assert.ok(exported.manifest.durationMs>1000);
  await writeFile('.local/capture-probe/frontend-native-recording.mp4',Buffer.from(exported.base64,'base64'));
  console.log('PASS frontend native preview → recording session → original MP4',JSON.stringify({bytes:exported.manifest.bytes,durationMs:exported.manifest.durationMs}));
} finally {
  if(session && app) await app.evaluate(sessionId=>window.__TAURI_INTERNALS__.invoke('native_screen_stop',{sessionId}),session.sessionId).catch(()=>{});
  await browser.close(); await host.close();
}




