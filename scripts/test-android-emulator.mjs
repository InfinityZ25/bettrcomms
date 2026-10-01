#!/usr/bin/env node
// Exercise the installed APK on a disposable emulator. Never captures a phone.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb';
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5554';
const flavor = process.argv[2] ?? 'standard';
assert(['standard', 'meta'].includes(flavor), 'Choose standard or meta');
assert(serial.startsWith('emulator-'), 'This check is restricted to disposable emulators.');
const shell = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(150); }
  throw new Error('Android acceptance step timed out');
}
shell('shell', 'am', 'force-stop', 'com.bettrcomms.android');
shell('shell', 'pm', 'revoke', 'com.bettrcomms.android', 'android.permission.RECORD_AUDIO');
shell('shell', 'pm', 'clear-permission-flags', 'com.bettrcomms.android', 'android.permission.RECORD_AUDIO', 'user-set', 'user-fixed');
shell('shell', 'am', 'start', '-n', 'com.bettrcomms.android/com.wails.app.MainActivity');
const pid = await until(() => { try { return shell('shell', 'pidof', 'com.bettrcomms.android').trim(); } catch { return false; } });
const port = Number(process.env.ANDROID_CDP_PORT ?? 19222);
shell('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
let socket, evaluate;
try {
  const pages = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.url === 'https://wails.localhost/'); }
    catch { return null; }
  });
  socket = new WebSocket(pages.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(message.error.message)) : entry?.resolve(message.result); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => evaluate('!!window.__BETTERCOMMS_DESKTOP__'));
  assert.equal(await evaluate('window.__BETTERCOMMS_DESKTOP__.platform'), 'android');
  assert.equal(await evaluate('window.__BETTERCOMMS_DESKTOP__.capabilities.nativeMetaCamera.state'), flavor === 'meta' ? 'experimental' : 'unavailable');
  assert.equal(await evaluate('visualViewport.scale'), 1);
  assert.equal(await evaluate('!!document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')'), true);
  assert.equal(await evaluate(`(async()=>{
    const module=await import(performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('wails-runtime-')));
    const runtime=Object.values(module).find(v=>v?.Call?.ByID);
    window.bcAndroidAudio=active=>runtime.Call.ByID(0xBC170101,window.__BETTERCOMMS_DESKTOP__.pageToken,active);
    window.bcAndroidCheck=(command,args={})=>runtime.Call.ByID(0xBC170102,window.__BETTERCOMMS_DESKTOP__.pageToken,command,args);
    try { await runtime.Call.ByID(0xBC170102,'test-only-invalid-token','native_screen_active',{}); return false; } catch { return true; }
  })()`), true, 'Native binding must reject an invalid host token');
  async function tapText(text, resourceId) {
    shell('shell', 'uiautomator', 'dump', '/sdcard/bc-check.xml');
    const xml = shell('shell', 'cat', '/sdcard/bc-check.xml');
    const node = [...xml.matchAll(/<node\b[^>]*>/g)].map(m => m[0]).find(n =>
      resourceId ? n.includes(`resource-id="${resourceId}"`) : n.includes(`text="${text}"`));
    if (!node) return false;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) return false;
    shell('shell', 'input', 'tap', String(Math.floor((+bounds[1] + +bounds[3]) / 2)), String(Math.floor((+bounds[2] + +bounds[4]) / 2)));
    return true;
  }
  // Exercise Android's real microphone prompt before starting the service.
  const askForMic = () => evaluate(`window.bcMicResult=null;
    navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());window.bcMicResult='granted'},e=>window.bcMicResult=e.name);true`);
  await askForMic();
  await until(() => tapText(null, 'com.android.permissioncontroller:id/permission_deny_button'));
  await until(() => evaluate('bcMicResult!==null'));
  assert.equal(await evaluate('bcMicResult'), 'NotAllowedError', 'Denied native permission must deny the WebView request');
  await askForMic();
  await until(() => tapText(null, 'com.android.permissioncontroller:id/permission_allow_foreground_only_button'));
  await until(() => evaluate('bcMicResult!==null'));
  assert.equal(await evaluate('bcMicResult'), 'granted', 'A denied permission can be retried through Android');
  await evaluate('bcAndroidAudio(true)');
  await evaluate(`window.bcShareResult=null;window.bcShareError=null;
    window.bcAndroidCheck('native_screen_start',{owner:'emulator-acceptance'}).then(r=>window.bcShareResult=r,e=>window.bcShareError=true);true`);
  await until(() => tapText('Share one app'));
  await until(() => tapText('Share entire screen'));
  await until(() => tapText('Share screen'));
  await until(() => evaluate('!!window.bcShareResult'));
  assert.equal(await evaluate('window.bcShareError'), null);
  const stats = () => evaluate("bcAndroidCheck('native_screen_diagnostics',{sessionId:bcShareResult.sessionId})");
  assert((await stats()).accessUnits > 0, 'Consent must complete only after native capture starts');
  await evaluate(`(async()=>{
    window.bcCheckPeer=new RTCPeerConnection();window.bcCheckVideo=document.createElement('video');
    bcCheckVideo.muted=true;bcCheckVideo.autoplay=true;bcCheckVideo.playsInline=true;document.body.append(bcCheckVideo);
    bcCheckPeer.ontrack=e=>{bcCheckVideo.srcObject=new MediaStream([e.track]);void bcCheckVideo.play()};
    const args={sessionId:bcShareResult.sessionId,peerId:'emulator-preview'};
    await bcCheckPeer.setRemoteDescription(await bcAndroidCheck('native_screen_peer_offer',{...args,iceServers:[],directOnly:true}));
    await bcCheckPeer.setLocalDescription(await bcCheckPeer.createAnswer());
    await new Promise((resolve,reject)=>{if(bcCheckPeer.iceGatheringState==='complete')return resolve();const t=setTimeout(()=>reject(new Error('ICE timeout')),10000);bcCheckPeer.onicegatheringstatechange=()=>{if(bcCheckPeer.iceGatheringState==='complete'){clearTimeout(t);resolve()}}});
    await bcAndroidCheck('native_screen_peer_answer',{...args,description:bcCheckPeer.localDescription.toJSON()});
  })()`);
  await until(() => evaluate('bcCheckVideo.videoWidth===720 && bcCheckVideo.videoHeight===1280'));
  await evaluate("bcAndroidCheck('native_screen_cancel_pending')");
  assert.equal((await evaluate("bcAndroidCheck('native_screen_active')")).sessionId,
    await evaluate('bcShareResult.sessionId'), 'Cancelling a pending picker must preserve a live share');
  const before = await stats();
  shell('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await delay(2000); // Let the home transition settle into a static screen.
  const staticScreen = await stats();
  await delay(2000);
  const background = await stats();
  assert(background.accessUnits - staticScreen.accessUnits >= 10,
    'A static screen must repeat frames so late viewers/keyframe requests can recover');
  assert(background.accessUnits > before.accessUnits, 'Native frames must continue after backgrounding');
  // Stop while the app is backgrounded: updating/removing the running
  // foreground service must not try to launch a fresh background service.
  await evaluate(`(async()=>{bcCheckPeer.close();bcCheckVideo.remove();await bcAndroidCheck('native_screen_stop',{sessionId:bcShareResult.sessionId})})()`);
  assert.equal(shell('shell', 'pidof', 'com.bettrcomms.android').trim(), pid, 'Background stop must not crash the app');
  await delay(500);
  assert(shell('shell', 'dumpsys', 'activity', 'services', 'com.bettrcomms.android').includes('.BetterCommsMediaService'),
    'Stopping a screen share in the background must preserve the active call service');
  await evaluate('bcAndroidAudio(false)');
  shell('shell', 'am', 'start', '-n', 'com.bettrcomms.android/com.wails.app.MainActivity');
  assert.equal((await evaluate("bcAndroidCheck('native_screen_active')")).sessionId, '');
  await delay(500);
  assert(!shell('shell', 'dumpsys', 'activity', 'services', 'com.bettrcomms.android').includes('.BetterCommsMediaService'), 'Foreground service must be released');
  console.log('PASS: Android launch, viewport, CSP, authorization, microphone denial/retry, projection consent, native 720x1280 receiver, background frames and stop cleanup.');
} finally {
  if (evaluate) {
    await evaluate(`(async()=>{window.bcCheckPeer?.close();window.bcCheckVideo?.remove();if(window.bcAndroidCheck){if(window.bcShareResult)await bcAndroidCheck('native_screen_stop',{sessionId:bcShareResult.sessionId});else await bcAndroidCheck('native_screen_cancel_pending')}if(window.bcAndroidAudio)await bcAndroidAudio(false)})()`).catch(() => {});
  }
  socket?.close();
  shell('forward', '--remove', `tcp:${port}`);
}
