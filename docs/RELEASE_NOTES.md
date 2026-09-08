# BetterComms preview release notes

## Unreleased — native compatibility quality

The desktop-viewer compatibility path now carries the native screen picker's
selected bitrate and frame-rate ceiling into its WebRTC sender instead of
silently reusing the global browser defaults of 20 Mbps and 60 FPS. It also
requests resolution-preserving adaptation and marks the native preview as
detail content, so WebView2 drops frames before reducing a 1080p source to
640×360 when local encoding load is too high. Connection details identify
ordinary browser screen tracks and native compatibility tracks separately.

Configured bitrate remains a ceiling rather than constant padding. Actual
bitrate varies with frame complexity and WebRTC congestion control, while
actual frame rate remains bounded by capture, decode, re-encode, receiver, and
network capacity.

Native desktop viewers again try the single-encode Rust H.264 route first,
matching the capture-to-network shape used by OBS. The measured five-second
zero-media recovery remains in place. Stream setup adds Automatic, Gameplay,
and Text & desktop content tuning; detected games prefer motion encoding and
balanced fallback adaptation, while desktop content preserves fine detail.

## Unreleased — realtime conversations and presence

Mezon's `deepfilternet3-noise-filter` 1.3.0 is now available as an experimental
browser and desktop-WebView microphone engine. Its SIMD WASM and DeepFilterNet3
model are pinned and self-hosted, the package loads only when selected, and
surfaced startup/runtime failures recover to RNNoise. RNNoise is now the default for new
clients. The WASM engine is not promoted as recommended: it passed realtime
data-flow and cleanup checks but reproduced its input exactly on the pinned
noisy-speech quality fixture. Evidence and asset hashes are recorded in
[`DEEPFILTER_WASM_FINDINGS.md`](DEEPFILTER_WASM_FINDINGS.md).

Signed-in web and desktop clients now keep one authenticated app-level WebSocket open while the user browses. New messages arrive as complete message records, and call rosters update immediately when a participant joins, leaves, mutes, deafens, reconnects, or adds another device. Room creation, renames, membership changes, direct conversations, friend requests, and friendship changes send targeted invalidation events to affected accounts. Online/offline friend state follows authenticated event-stream connections and is aggregated across multiple open devices.

PostgreSQL remains authoritative for history, rooms, membership, and friendships. Clients load those records through HTTP on first load and reconcile them after a WebSocket reconnect or a targeted change event; the former 3-second message, 2-second call-presence, and 10-second room polling loops are removed. Message sends append the returned record locally and deduplicate the corresponding pushed event instead of downloading the entire history again. Server-side subscriptions are derived from authorized room membership and friendships, so clients cannot subscribe themselves to another room.

The realtime hub remains process-local, matching the existing single signaling-process deployment. A future multi-replica deployment must add shared fanout such as PostgreSQL `LISTEN/NOTIFY` or Redis before enabling more than one API replica.

## 0.1.12 — native screen shape preservation

Windows native sharing now treats 720p, 1080p, 1440p, 4K, and Match source as maximum resolution bounds while preserving the selected window or display's actual aspect ratio. FFmpeg no longer pads narrow, portrait, ultrawide, or unusually shaped application windows into a fixed 16:9 canvas, so receivers and recordings no longer contain encoded black pillars or letterboxing. Encoder dimensions remain even and within the selected quality bound for H.264 compatibility.

## 0.1.11 — high-refresh native screen sharing

Windows native sharing adds a 720p output option, a 120 FPS preset, custom whole-number frame rates from 15–240 FPS, and custom whole-number bitrates from 1–200 Mbps. The selected rate flows through Windows Graphics Capture, FFmpeg hardware encoding, H.264 negotiation, native RTP pacing, diagnostics, and local native recording. Invalid inputs and combinations above H.264 Level 5.2 are rejected before capture; actual delivered FPS can be lower when the source, encoder, receiver, or network cannot sustain the request.

Actual Windows acceptance passed 1280×720 at 120 FPS/12 Mbps and 240 FPS/20 Mbps through both an RTX 4070 SUPER NVENC path and Ryzen integrated-graphics AMF path. Chromium decoded approximately 120.5–120.7 FPS and 240.9–241.4 FPS respectively, and the frontend recording path produced a playable native-copy MP4. The browser fallback continues to use browser capture and its runtime limits.

## 0.1.10 — bundled native sharing, multiple devices, and adaptive call gallery

Windows installers now include the pinned FFmpeg 8.1 native-sharing runtime, its GPL license, setup metadata, and source/build references. A fresh install can start native window or display sharing without WinGet or a separate 236 MiB first-run download. Rust resolves the packaged resource before the older private app-data runtime; the in-app downloader remains available as a repair fallback if the packaged files are missing. This requires the 0.1.10 Windows app. macOS remains on browser-supported screen capture and does not receive the Windows runtime.

One account can now join the same call from several devices. Each call endpoint receives an opaque device peer ID for WebRTC and optional voice-relay routing while room presence remains grouped under the account with a device count. A device entering an active call sees explicit choices to move the call with **Reconnect from here** or preserve the existing endpoint with **Connect second device**. Reconnecting closes every older call endpoint for that account; adding a device lets each endpoint independently publish or consume microphone, camera, screen, and system audio.

Settings offers an opt-in Push-to-talk checkbox and a keyboard or mouse shortcut. It is disabled by default and saved on this device. Calls transmit the processed microphone only while the shortcut is held; manual mute and deafen take priority. Settings changes, disconnect, and leaving release the shortcut. Device and denoiser replacement retain the current microphone gate, including replacements still waiting on WebRTC senders.

Waiting for the shortcut stays separate from manual mute in call controls and participant presence. The microphone capture remains live while the processed output sends silence. Keyboard shortcuts work after clicking mute/unmute, and foreground Windows input uses WebView events without depending on a duplicate global hook event. Editing and shortcut assignment remain protected; assigned Space/Enter no longer also activate the focused call button. Regression tests exercise Left Ctrl, continuous capture, transmitted audio/silence, and independent mute state.

The Windows Tauri host provides global keyboard and mouse input through native hooks during enabled calls. The frontend reports connection failures and keeps the microphone muted until registration is restored. Native registrations expire without a frontend heartbeat and are removed when disabled, rebound, or disconnected. The browser and other operating systems use foreground input and release on focus loss. Camera, screen, system audio and playback volume remain independent. Actual Windows acceptance passes background keyboard and all five mouse buttons, minimized keyboard/mouse operation, passthrough, mute/deafen, rebinding, cleanup and lease expiry. Input snapshots use native window focus to avoid a WebView2 focus mismatch after restoration. See [push-to-talk and local setup](PUSH_TO_TALK.md) for use and acceptance scope.

Native screen receivers now request an automatic compatibility path when the dedicated native connection delivers no video bytes for five seconds or fails. The sender republishes its already-decoded native preview through that viewer's established call peer connection, then closes only the failed native sender leg. Healthy viewers retain the direct Rust-to-WebRTC hardware-encoded path. Diagnostics record fallback requests and activation. This hosted frontend recovery works with existing 0.1.9 desktop apps; it does not fix the underlying separate native ICE path or make FFmpeg unnecessary for sending native captures.

Native screen capability negotiation now identifies desktop WebView receivers. Those viewers use their established ordinary call peer connection immediately, matching the transport path used by reliable browser sharing and avoiding the dedicated Rust-to-WebView2 connection that has repeatedly delivered zero RTP in field reports. Browser viewers retain direct Rust H.264 delivery. An unknown or older receiver still attempts native delivery and retains the five-second recovery. This routing update is hosted and works after existing 0.1.9 apps reload.

Fullscreen calls now clip their outer canvas to the dynamic viewport and hide WebView scrollbar gutters, removing the stray bar that could appear along the bottom edge in the Windows desktop app.

Shared content now zooms from 50% to 500% with small button steps, ordinary mouse-wheel scrolling, and trackpad pinch/scroll gestures. Wheel zoom is anchored under the pointer, animated without adding a frame loop, and bounded so dragged content cannot be lost completely off-canvas. Each watched item keeps its own zoom and pan while it remains mounted.

Every participant can continue publishing one independent screen track. Incoming shares first appear as preview tiles beside participants and move onto the main stage after the viewer chooses Watch. Viewers can watch several shares in a responsive center grid, focus one share, move a live camera onto the center stage, return to all watched shares, or stop watching any share. Watched screen audio follows the same selection so multiple unwatched game feeds do not play over the call. Local sharing opens on the sharer's stage automatically.

Calls without a screen share now use the full stage as a responsive camera gallery instead of leaving a shallow camera strip above unused space. Adaptive view gives the active speaker more room in three-person calls; Equal grid keeps every tile the same size; Focus lets the user pin any participant. A local fit/fill preference controls whether cameras are cropped to use the tile or shown in full. Gallery preferences persist on the device, and shared-content calls keep the existing resizable top/side camera docks.

The gallery toolbar only presents controls that apply to the current state. Pin controls appear on hover or keyboard focus, the layout collapses cleanly for narrow windows, and fullscreen retains the selected gallery. The call-layout browser acceptance test now covers gallery sizing, saved view/fit preferences, screen-share docking, fullscreen, focus mode, and mobile overflow.

Camera tiles now follow each incoming track's actual aspect ratio, including portrait phone cameras, instead of stretching the tile when the chat panel or window width changes. Fullscreen uses the complete viewport; its call toolbar, media labels, zoom controls, and footer float above the media and fade after pointer inactivity. Moving the pointer or using the keyboard reveals them again. Shared content can switch between Fit and Fill.

An active call is now owned independently from the room being browsed. Opening another room or direct conversation keeps the original media engine and signaling session alive; leaving remains an explicit call control. The layout acceptance test navigates away from and back to the active call room and verifies the call stays connected.

## 0.1.9 — 24 FPS camera overlay

The Windows camera overlay now targets 24 FPS instead of 10. Rust paces frames against absolute deadlines rather than silently dropping early frames or accumulating timer drift. Native painting reuses its bitmap and avoids per-frame window positioning. The frontend submits one frame at a time without adding a competing timer on modern hosts. Frame submission remains sequential with no stale-frame backlog. Actual cadence depends on source cameras and local rendering load. An updated native 0.1.9 binary is required; older hosts retain their advertised 10 FPS limit. The unpublished 0.1.7 and 0.1.8 candidates were superseded after timing and multi-camera validation.

Validation: web build, 72 unit tests and two overlay/layout browser tests passed. Rust passed 52 tests with 11 hardware checks ignored. Optimized Windows live-camera checks measured 23.18 FPS for one camera and 8.01 FPS for four synthetic sources. Multi-camera throughput remains a known limitation.

## 0.1.6 — native camera overlay

Windows calls offer Camera overlay in the call layout toolbar. The optional Rust-owned, always-on-top window shows up to four camera previews, participant labels and mute/deafen/speaking state. Corner and size presets, click-through by default, and optional self-view are available. The overlay uses the display containing BetterComms and fits its work area. Leaving the call closes it; a native watchdog also closes it after missing frontend frames. It requests exclusion from screen capture to avoid recapturing the overlay into shared content.

The call WebView supplies small RGBA composites through bounded binary IPC at up to 10 FPS; Rust paints the overlay without an extra WebView, device capture or audio playback. Source tracks and recordings are unchanged. Desktop background rendering remains active for call previews when occluded. This works with the Windows desktop/windowed/borderless approach; exclusive fullscreen and anti-cheat game compatibility are not established. macOS and browsers do not offer this Windows-only overlay. An updated native binary is required.

Browser GPU-only DeepFilterNet was evaluated but is not enabled. A fixed-shape GRU conversion passed ONNX validation and 100 stateful CPU-reference frames, but strict hardware WebGPU inference failed in ONNX Runtime Web 1.29 before producing audio. The conversion script remains in `scripts/prepare-deepfilter-webgpu.py` and findings in `scripts/experimental/`; no unused browser model/runtime or hidden CPU fallback ships.

Validation: web build and 72 unit tests passed; the full browser run passed 71 tests with one optional TURN check skipped. Rust passed 51 tests with 11 opt-in checks ignored. An isolated Windows host passed overlay binary IPC, size changes, invalid/stale grant rejection, source ownership, UI controls and the actual no-frame watchdog timeout. These checks do not establish exclusive-fullscreen game compatibility.

## 0.1.5 — native screen diagnostics and decoder initialization

Connection details offers Download diagnostic report. The JSON includes client/runtime version, bounded native-screen signaling events and receive samples, separate screen ICE/connection states, negotiated H.264 profile identifiers, selected candidate types/protocol (without addresses), packet/frame/decode counters, and video-element readiness. Native 0.1.5 adds sender encoder settings, encoded frame/keyframe/byte counts, actual SPS profile bytes, and anonymous per-connection state/RTP/feedback counters. Older hosts report that native sender diagnostics are unavailable. Export while the call and problematic share are still active; these diagnostics stay local until explicitly exported.

The sender retains bounded SPS/PPS initialization data and supplies it with later IDR frames when absent, so a receiver joining after the initial headers can initialize its H.264 decoder. Existing parameter sets are not duplicated. This addresses a concrete recovery gap, but does not establish the cause of the reported Windows-native-only viewing failure. Browser sharing and native sharing use separate peer connections; a working direct call does not prove the native screen connection is healthy. Immediate encoder keyframe generation in response to PLI/FIR remains unsupported; periodic IDRs still govern recovery.

Reports exclude call media, raw SDP/candidates, IP addresses, authentication/TURN credentials, window titles, device identifiers, and participant IDs. They use local peer aliases; aliases are not identities shared between reports.

## Adjustable call workspace

Active calls expose a Camera position control with top, left, and right docks. Drag the camera handle to preview and snap to a dock, or drag the divider to resize; the divider also supports arrow keys and Home/End. Camera sizes are bounded by available space, saved locally, and resettable. Small windows arrange cameras above the content. Without a share, participants fill a camera gallery rather than surrounding an unused share illustration.

Fullscreen includes the entire call workspace, retaining cameras and call controls. Focus call hides navigation and chat until restored (or Escape). Joining collapses chat, which remains available from the header. The header, padding, recording notice, and sidebar are reduced during calls. These are hosted frontend changes and do not require another desktop installer.

The layout acceptance test checks drag docking, bounded resizing, saved sizing, fullscreen visibility, focus navigation, mobile overflow, and preservation of the live decoded screen track across transitions.

## 0.1.4 — recording format exports

Recordings offers an Export a copy format selector beside each original track. WebM video can be converted locally to H.264 MP4, and audio to uncompressed WAV. Desktop 0.1.4 additionally supports 256 kbps MP3 through its installed FFmpeg runtime. Browser MP4 requires available H.264/AAC WebCodecs encoders; unsupported codecs produce an actionable error. Conversion code loads only when requested. Older desktop hosts can use the browser conversion path for MP4/WAV.

Exports preserve independent participant tracks and do not apply playback volume adjustments or replace originals. Audio already embedded in a video is retained; separate microphone and system-audio files are not automatically mixed into the video. Native MP4 uses CRF 18 H.264 and optional AAC audio. Progress and cancellation are available, and native exports use a save dialog with atomic completion. Source files are limited to 512 MiB; browser output is limited to 512 MiB and native output to 2 GiB. Native conversion is bounded to two concurrent jobs and 30 minutes per job.

Real synthetic WebM acceptance checks decode exported MP4 video and embedded audio, WAV, and native MP3, verify source preservation, and exercise cancellation. Native conversion was exercised on Windows; macOS uses the browser conversion path where supported.

## Room lobbies and call presence

Rooms and direct messages have separate navigation groups. A conversation lobby shows the current call roster before joining, rather than presenting a fake local participant and an inactive screenshare stage. Muted and deafened participants are visible both inside the call and to authorized room members outside it. Deafen silences call playback and mutes the microphone, then restores the previous microphone state when disabled. Incoming recordings and saved output preferences are unchanged.

Presence is ephemeral signaling memory; no mute/deafen rows or updates are written to PostgreSQL. The lobby refreshes one authorized snapshot every two seconds, and failure is shown as unavailable rather than an empty room. This does not expose private calls to friends who are not members. See `CALL_PRESENCE.md` for the single-process deployment constraint and decentralization tradeoffs.

Validation covers two-account room and DM rosters before joining, reciprocal direct-conversation labels, mute/deafen while observing and joined, measured deafen silence/restoration, authorization, lifecycle cleanup, and desktop/mobile layout and accessibility. Build, 65 web unit tests, Go tests with local PostgreSQL, and Go vet passed. The browser pass covered 67 tests, with the optional TURN check skipped; the DM fixture's local origin was corrected and rerun separately. No native IPC or installer change is required for this hosted update.

## 0.1.3 — call-audio exclusion and centralized volume

Windows system sharing excludes the validated WebView2 browser process tree by default. Excluding the outer Tauri process tree leaked WebView playback in a controlled native test: the app's 770 Hz signal measured 0.192614 before and 0.000003663 after the correction, while an external 660 Hz signal was retained. The native picker now exposes Exclude call audio, checked by default. Explicitly unchecking it uses whole-endpoint loopback and includes the call. Missing or ambiguous WebView ownership stops protected capture rather than silently capturing everything. This correction requires desktop 0.1.3.

Settings places Input volume and Output volume beside the devices and microphone tests. Both default to 100%, range from 0–200%, persist locally and update active audio without reacquiring devices. Input volume replaces the old dB gain control, retaining its equivalent value within the new range until changed. Automatic gain, echo cancellation and filters remain in Advanced audio controls. Output volume applies to call playback, recorded samples, loopback, test tones and the recording player; participant/track volumes stay independent and original recording assets remain unchanged. Real signal tests cover live input/output scaling, silence, element playback, per-track volume and cleanup.

## Browser window-audio preference

Browser sharing now requests `windowAudio: 'window'` when audio is enabled, instead of leaving window-audio scope unspecified. Supporting browsers can offer the selected application's audio; this is a browser/OS-controlled hint, not a guarantee of per-process isolation. Entire-screen audio can still include system sound, and browser-tab audio follows the selected tab. Desktop 0.1.2 provides the explicit native process-tree option. Build, unit and targeted capture-lifecycle checks validate the request and cleanup; physical browser window-audio behavior remains dependent on the browser's picker.

## 0.1.2 — direct-call audio decoding and application audio

Remote playback retains a muted media element for each audio track to start Chromium's WebRTC decoder. The audible signal still runs exclusively through the existing Web Audio volume, optional microphone balancing and output-device graph. Previously, packets could arrive with live tracks and a running AudioContext while decoded audio energy stayed at zero. A real two-engine regression reproduced that behavior for both microphone and system audio. Decoder consumers are removed when tracks end, playback detaches or the call closes. This hosted frontend correction does not require a new desktop installer; real cross-network confirmation remains pending.

Sender bitrate configuration now waits for WebRTC-owned encoding entries instead of fabricating them before negotiation, which could reject adding a shared-audio track. Connection statistics include codec, source audio energy, received samples and concealed samples to distinguish capture, transport and decoding failures.

The 0.1.2 native build supports selected-application audio using Windows process-loopback inclusion. Window shares default to that process tree; users can explicitly choose system audio excluding BetterComms. Older installed backends cannot silently substitute all system sound for application audio. A real two-process test captured the selected 660 Hz tone while excluding an unrelated 880 Hz tone. This native change requires an updated binary and is not included in 0.1.1.

## Speaking indicator sensitivity

The visual speaking threshold defaults to -48 dBFS instead of roughly -29 dBFS. Settings offers a persisted Speaking indicator threshold control that applies during calls, with a lower release threshold to avoid flicker. This only changes the green border; it does not gate, amplify or control transmission of microphone audio. The indicator measures the processed microphone before transport, so it is not a server-delivery acknowledgment. Connection reports now include microphone processing preferences and the indicator threshold to help distinguish low input, optional gating and display sensitivity. Regression checks exercise quiet input, background-level signal, live sensitivity changes, mute, cleanup and setting persistence.

Explicit microphone tests also measure input and processed RMS levels with floating-point samples, replacing the byte-quantized level display. Copy microphone diagnostics includes capture formats, browser engine versions, processing preferences, per-input-channel levels and the loudest observed levels, without audio or device identifiers. Raw microphone analysis stays local, shares the existing test context and is disconnected on stop. A synthetic -12 dB gain test confirms the diagnostic readings distinguish input from processed output. The reported desktop-versus-browser loudness difference is not yet reproduced on the user's physical microphone; visual sensitivity is not presented as a fix for that difference.

## Microphone channel correction

Microphone capture now prefers mono. RNNoise and Speex explicitly mix stereo input to one channel before their single-channel DSP; the processor's `maxChannels: 1` option alone previously left a silent second channel or discarded an interface's right input. NVIDIA/DeepFilterNet input also explicitly mixes to mono, and processed microphone destinations publish one channel. A stereo microphone returned despite the capture preference is downmixed even when optional effects are off, using a lightweight gain node. This applies to new microphone samples, live monitoring and call microphones. Screen/system audio remains stereo; previously recorded assets are unchanged.

The channel regression uses real RNNoise, Speex and neutral processing with both left-only and right-only stereo inputs. All six cases produced mono tracks and nonzero matched left/right playback, including encoded Opus samples decoded through an audio element. This verifies channel routing with synthetic input; physical earbud/device balance remains a device check. The fix ships through the hosted frontend and does not require a new native installer.

## 0.1.1 — call playback and native sharing reliability

Remote microphones and shared audio now use one playback context, unlocked synchronously when joining. Windows WebView2 explicitly permits application playback, so ordinary calls should not require an extra Enable audio click. Browsers retain their normal autoplay restrictions and recovery control. Per-person volume and microphone balancing remain playback-only; source recordings are unchanged.

Native screen senders queue early ICE candidates until their remote answer exists. Incoming screen signaling is serialized per capture, and disposed or replaced receivers cannot send stale answers. The viewer reports missing or stalled frames instead of labeling a black surface Live. Connection details include native decoded-frame counters and a copyable report without media, IP addresses, peer identifiers or credentials.

Windows x64 has an explicit in-app FFmpeg installer with pinned archive/file hashes and a private runtime directory. No Winget command or PATH change is required. Browser sharing remains available. Both callers should install 0.1.1: hosted UI changes cannot upgrade the Rust backend or WebView configuration in older installers.

Validation includes a real native candidate-before-answer regression, a private FFmpeg download and native thumbnail capture, and native process-loopback retaining an external tone while excluding the app process tree. These tests do not establish that every physical device or cross-network call is fixed. Camera, screen video and system audio still need working WebRTC connectivity; only microphone audio has the WebSocket fallback. Desktop previews remain unsigned, and macOS hardware behavior is unverified.

The Windows 0.1.1 executable passed a fresh-profile hosted smoke: playback starts without a page gesture or test autoplay override, FFmpeg setup IPC is available, and external authentication pages cannot invoke native commands. Frontend build, 62 web unit tests, 40 Rust tests (8 opt-in hardware tests excluded), the 51-test browser pass, and four focused runtime/playback tests passed. The optional TURN browser check remains skipped. The audio test measured nonzero samples through both shared-audio and balanced-microphone playback paths without Chromium's test autoplay bypass.

## Earlier development milestones

This is a working browser vertical slice and native application foundation, not a completed replacement for Discord or a public production release.

## Microphone fallback over WebSockets

Calls prefer WebRTC and now attempt encrypted server voice after eight seconds without a connected peer path. Settings → Connection includes explicit Server voice compatibility mode; Direct connections only prevents this route in both directions. Diagnostics show Server voice and distinguish signaling-server ping from end-to-end media latency. Camera, screenshare, and system/application audio remain on WebRTC and still need direct connectivity or TURN.

The fallback sends processed mono Opus microphone audio, starts at 64 kbps, adapts down on socket backlog, and preserves mute, independent source recording, and local playback volume. Bounded client/server queues discard stale unsent audio. Fresh ephemeral keys, replay checks, and a manually comparable verification code protect relay payloads; public-key delivery still trusts authenticated signaling unless users compare codes through another channel. See [voice relay](VOICE_RELAY.md) for the trust model and runtime/operational limits.

Restoring direct voice requires a fresh readiness acknowledgment after a stable WebRTC path. Recording now supports returning to a previously recorded track with a separate timed segment and unique segment ID. No server recording or rewind retention was added.

Validation: production frontend build, 58 unit tests, 50 browser tests (optional TURN test skipped), and Go tests/vet with local Docker PostgreSQL passed. The real-room browser test verified automatic fallback, decoded processed audio, mute silence, relay socket reconnection, and recovery to direct WebRTC. A packaged Windows smoke confirmed Opus encoder/decoder and track-processor capabilities, native IPC, and the external-auth origin boundary. This is not a physical-device/cross-network voice quality test, and macOS relay support remains unverified.

## Working browser flows

WorkOS login integration and explicit localhost test login, opaque revocable PostgreSQL sessions, friend discovery/requests/acceptance, private rooms and direct rooms, room owner controls, persistent chat, microphone/camera calls, screen sharing with browser-supported audio, per-participant playback gain, optional voice balancing, standard/RNNoise noise suppression, adjustable quality ceilings, direct-only/prefer-direct mode, live route statistics, camera-top/side/focus layouts, zoom/pan/fullscreen, and per-track browser recording downloads.

Recordings capture the tracks received by that client before local playback volume/normalization. They are not original uncompressed remote source recordings. Tracks added during recording get individual start offsets. Stopped recordings automatically save their original blobs and timing manifest to a local IndexedDB library, shared by the browser and desktop implementation (each profile/origin has its own library). The Recordings screen provides synchronized playback, separate audio volume/mute controls, video source selection, seek, rename, delete, and original-file downloads. Playback adjustments do not rewrite source files. The current recorder retains at most 512 MiB of compressed chunks until stopped, automatically stops at the cap, and reports truncation. A save failure keeps download links available and explicitly reports that the recording was not saved. Completed recordings survive ordinary restarts; clearing profile/site data removes them. There is no active-recording crash recovery or gap-free DVR yet.

## Automated evidence

- Go unit, authorization, session, and real PostgreSQL WebSocket tests.
- TypeScript check and Vite production build.
- Browser tests with two isolated accounts, real persistence and WebRTC, decoded synthetic camera streams, screen transport, and parsed separate-track recording output.
- RNNoise worklet output and ownership/disposal test in Chromium.
- Local coturn relay-only data-channel exchange with selected relay candidates on both peers.
- Windows MSVC checks, two Rust unit tests, and Tauri release executable build; native development window launched and responsive.

The tests use synthetic media. They do not establish end-to-end latency or quality with real GPUs, sound devices, games, external NATs, or restrictive networks. WorkOS callback configuration is installed in the user's staging environment; completing an interactive WorkOS sign-in remains a user-account smoke test.

## Not yet implemented or verified

- Continuous viewer rewind and disk-backed recording recovery/export synchronization suitable for professional editing.
- Injected exclusive-game capture, process-specific audio, AV1/HEVC native sharing, or Krisp SDK. Windows window/display capture and H.264 encoder selection are available in the development implementation described below.
- Packaged desktop authentication and API routing. The native development preview uses the local Vite proxy; the Windows toolchain and executable build are validated.
- Community/role/channel hierarchies beyond private rooms, SFU voice mode, large-group mesh limits, signed desktop releases, and macOS/Linux parity.
- An externally reachable production server and TURN service, HTTPS domain, bandwidth/load testing, or a complete accessibility audit.

The UI does not present these unavailable capabilities as working controls. Their contracts and acceptance gates are in the specification and native roadmap.

## Native screen sharing and original MP4 recording (2026-09-05)

The desktop now offers an in-app window/display picker, native Windows Graphics Capture, encoder probes and H.264 NVENC/AMF/QSV/x264 controls, 30/60 FPS, resolution, bitrate, and cursor selection. The encoded stream goes directly to a native WebRTC sender; local native recording remuxes those same access units to MP4 without re-encoding. Browser clients keep browser capture; desktop users can explicitly choose browser sharing when captured audio is required. Native video currently has no captured audio or exclusive-game hook.

Actual NVIDIA RTX 4070 SUPER and AMD integrated graphics tests decoded the selected synthetic window at approximately 60 FPS, 1280 × 720, with verified colors. Both native MP4 exports passed; the real frontend preview-to-recording flow produced a valid H.264/BT.709 MP4. Native helper processes were absent after stop. The test harness checks the restarted host's recording export command registration. Higher resolutions are selectable, but sustained 4K60 gameplay, cross-network native TURN, and combined denoising/game load remain unverified.

Settings now expose a separate browser/received-screen recording bitrate (10/20/40/80 Mbps), with a 20 Mbps default. Camera and audio defaults are 8 Mbps and 256 kbps. Native recording transfers use binary IPC and share the recording session's 512 MiB retained-data cap. See [native sharing](NATIVE_SHARING.md) for runtime requirements and remaining limits. A guarded Tauri development launcher keeps frontend/native commands paired and reuses the workspace's running Vite server.

Regression testing exposed an intermittent simultaneous-join discovery race. The server now atomically registers each connection and snapshots its existing peers, so neither caller misses the other. A concurrent eight-joiner test passes 100 iterations. Per-peer processing also serializes received offers, answers, and candidates.

Camera settings now offer Auto/720p/1080p/1440p/4K and 15/30/60 FPS, defaulting to 1080p30. Preview reports requested and delivered settings, probes capabilities only after explicit activation, and marks unsupported ranges. Quality changes safely replace preview/call capture. The native screen picker preserves focus and scroll across periodic call updates; its initial focus setup no longer reruns when callback props change.

## Optional NVIDIA microphone processing

The Windows desktop now integrates NVIDIA Audio Effects directly, with an app-private runtime/model and no Broadcast application requirement. The initial automatic package targets Ada/RTX 40-series GPUs. Readiness is gated on a real GPU frame-processing probe. The outgoing mono 48 kHz microphone uses a bounded AudioWorklet/native bridge and falls back visibly to RNNoise on sustained processing failure. The actual RTX 4070 SUPER passed native WebView integration and cleanup checks with synthetic input. See [NVIDIA setup](NVIDIA_SETUP.md) for installation and remaining physical-device acceptance.

## Recordings acceptance (2026-09-05)

The local library and multitrack player passed tests with real synthetic MediaRecorder audio/video blobs: automatic call-save integration, two video sources, independent audio volume/mute, late-source timing, seeking, retained partial tracks, and deletion. Storage tests verified byte-for-byte retrieval after closing and relaunching a persistent Chromium profile, atomic replacement, rename/delete, and rollback on a simulated quota failure. The full browser suite passed 10 tests with the opt-in TURN check skipped; nine web unit tests passed. Desktop and mobile player screenshots were inspected. These checks establish local profile persistence and browser decoding, not in-progress crash recovery or compatibility with every external media editor.

## Device settings and desktop permissions (2026-09-05)

Settings now enumerate microphone, camera, and output choices, refresh on device changes, provide a five-second microphone sample using the same selected processing pipeline as calls, with a level meter/playback, a local camera preview, and a speaker test tone. Playback output changes apply to live call audio and recording audio; they never alter recorded source tracks. Unsupported output routing and unavailable devices produce actionable errors. Test capture is explicit, local, and released on close, device change, cancellation, and late permission completion.

On Windows, explicit enable/test/preview/join actions set microphone/camera permission through Tauri IPC and WebView2 Profile4. Permission changes are restricted to the trusted app origin. Unconfigured microphone/camera requests are denied rather than showing a generic WebView permission popup. This restores a previously denied app permission; it does not bypass Windows privacy settings, replace WebRTC capture with native device frames, or remove the browser screen-share chooser. Browser clients retain browser permission controls. Native status normalizes WebView2 origin formatting before comparison.

Validation: fourteen browser tests passed (TURN opt-in skipped), nine web unit tests passed, and thirteen Rust tests passed (NVIDIA hardware unit test opt-in). A native WebView2 check denied then re-enabled both microphone and camera, verifying synthetic getUserMedia rejection/recovery and track cleanup without fake permission UI. Desktop/mobile settings screenshots were inspected. The native preview was restarted normally after testing with no debugging endpoint or fake-device flags. Physical microphone/camera quality and physical speaker routing remain device acceptance checks.

## Dedicated workspace screens

Settings and Recordings now occupy the main workspace instead of modal dialogs. Their hash routes (`#/settings` and `#/recordings`) support direct entry, refresh, and browser history. Each screen provides workspace navigation and Back to call; Escape also returns to the call and restores the launching control's focus. The call stage remains mounted while hidden so switching screens preserves live media and active recording. Settings device tests and recording playback are released when leaving their screen. Room/friend/create dialogs remain contextual dialogs.

Screen acceptance: fifteen browser tests pass (opt-in TURN skipped), including dedicated-screen desktop/mobile accessibility audits, browser history/reload, Escape/focus restoration, pending device-test cleanup, and a two-member call remaining connected through both screens. Nine web unit tests and the desktop release build pass. Device-settings tests no longer create unnecessary accounts, keeping the full suite within the unchanged authentication rate limit.

## Shared microphone processing and tuning

Calls and microphone tests now use the same capture options and MediaEngine processing chain. Tests label the actual engine, honor the suppression master switch, apply saved tuning, and report NVIDIA fallback rather than claiming NVIDIA processing. Browser sessions resolve stale NVIDIA preferences to standard browser processing without invoking native IPC; RNNoise remains an explicit browser-compatible WebAssembly option. Native permission and NVIDIA SDK actions remain gated to Tauri.

NVIDIA exposes its documented intensity ratio and opt-in speech-only VAD. RNNoise has no native strength parameter; common post-processing controls are explicitly separate: gain, low-cut, and a quiet-sound gate with threshold, attack, hold, and release. Echo cancellation and automatic input gain configure browser/WebView capture. The post-processing worklet runs off the UI thread and downmixes to mono when enabled; neutral settings add no effects graph. Changes apply with an explicit Apply button to avoid repeatedly reloading the GPU model while dragging sliders.

Validation: nineteen browser tests passed (TURN opt-in skipped), including actual decoded RNNoise output, master-off and browser-native gating, shared tuning, quiet-signal gate attenuation, playback/lifecycle checks, and accessibility. The installed RTX GPU processed frames at intensity 0, 0.5, and 1 and with VAD enabled. A native UI test completed a NVIDIA microphone sample with 50% intensity, VAD, gain, low-cut, and gating; the 30-second renderer-stall regression and mute/cleanup checks also passed. All native UI inputs were synthetic; physical voice quality remains a listening check.

## Delayed live microphone monitor

Settings now offer Start/Stop live loopback alongside the existing five-second sample. The monitor uses the same microphone processing engine and settings as calls and samples, routes to the selected output, and adds a fixed one-second Web Audio delay with an independent monitor volume (initially 50%). It creates no recording files or growing chunk queue. Switching tests, stopping, leaving Settings, changing the microphone or processing configuration, or a reported processing/routing failure releases the monitor and discards delayed audio. Headphones are recommended to avoid acoustic feedback. The browser/native processing boundary is unchanged.

Validation: three loopback tests pass, including a measured delayed synthetic signal, output routing, sample/live replacement, no live MediaRecorder, and cleanup. The full browser run passed 21 tests with TURN skipped and one two-person connection timeout; the connection test passed unchanged on targeted retry. Nine unit tests, the web production build, and the native Cargo release build pass. Physical microphone listening remains a manual check.

## Continuous monitor recovery and SpeexDSP

Live monitoring remains an uninterrupted Web Audio stream delayed by one second; there is no sentence detector, recording duration, or one-second chunk playback loop. The monitor now disables echo cancellation only for its own capture, because monitoring one's own voice can feed the echo canceller and suppress speech. Calls and five-second samples retain their saved echo setting. Headphones are required to avoid feedback, and the selected denoiser, gain and gate still apply. This addresses a plausible cause of reported missing speech; synthetic tests cannot establish the cause of a particular physical microphone dropout.

When the media engine replaces the processed microphone (including NVIDIA falling back to RNNoise), the monitor reconnects its source while retaining the same delay buffer and output graph. It reports the active engine without terminating the test. A processor outage may still leave a gap while the fallback starts; existing buffered audio is not deliberately discarded.

SpeexDSP is now an alternative shared by calls, samples and live monitoring, using local WASM in an AudioWorklet on both browser and desktop. Its shipped wrapper exposes no strength parameter, so the interface keeps gain and gating separate. Krisp remains deferred at the user's request; the vendor requires a commercial SDK license and SDK assets, which are not available in this workspace.

References: https://developer.chrome.com/blog/more-native-echo-cancellation/ ; https://sdk-docs.krisp.ai/docs/licensing-information

Validation: 27 browser tests pass (opt-in TURN skipped), including eight seconds of sustained audio sampled every 50 ms with no observed dropouts, one continuous delay graph through silence/resumption and processed-track replacement, and measurable Speex stationary-noise attenuation plus failure cleanup. Nine unit tests, the web production build, and the desktop Cargo release build pass. Physical speech quality remains a listening check.

## NVIDIA scheduling recovery and readiness probes

An isolated NVIDIA output underrun now re-primes a bounded 80 ms playback buffer instead of failing after three missing frames. Normal startup uses 40 ms. Outstanding input is capped at 240 ms and stale output is trimmed; no raw microphone audio is mixed into the processed path. Permanent stalls, a 250 ms timeout, malformed output, or four recoveries in ten seconds still cause an explicit RNNoise fallback. Recovery can include an audible gap. Diagnostics count underruns, dropped frames and current buffer target.

Native successful readiness probes are cached for 60 seconds, and model initialization is serialized across probes and capture startup. The status path rechecks for an active validated stream after waiting, avoiding a redundant model load. This reduces avoidable GPU model-loading spikes on repeated Settings visits. The reported screenshot alone does not establish GPU memory leakage or the original scheduling delay's cause.

Validation: 17 web unit tests and 16 native unit tests pass (one installed-SDK test remains opt-in); 27 browser tests pass with opt-in TURN skipped. Actual RTX 4070 SUPER validation passed the 30-second renderer-stall, forced native termination, muted capture replacement and cleanup tests. A new hardware jitter test held one real NVIDIA response for 120 ms: it recovered without fallback, reported one underrun and an 80 ms buffer, and continued processing 550 frames over six seconds. Six consecutive native readiness checks returned ready in 1.2-2.8 ms. The ordinary desktop preview was restored with temporary CDP debugging disabled.

Both web production and native release builds pass.

## Recording fullscreen and original-file export

Recordings now have a larger video stage and a fullscreen control, also available by double-clicking the video. Fullscreen retains transport, video source selection, and independent audio controls. The mixer can collapse without disconnecting audio; longer mixers scroll. Playback position, mute, and volume survive fullscreen changes.

Original assets have explicit Download actions in the browser and native Save As actions on desktop, with participant/source labels and original filenames. Desktop exports use bounded sequential chunks, progress, cancellation, and error feedback. A user-selected destination is written through a temporary staging file and replaced atomically only after the declared byte count is complete. Playback adjustments never modify exported source bytes. This also fixes original-file exports immediately after stopping a call recording.

Validation includes a real Windows Save As export of 614,431 bytes with exact byte comparison, native fullscreen expanding to the display dimensions, browser download events and SHA-256 equality, fullscreen playback/node preservation, and desktop/mobile screenshots. Twenty-two web unit tests, twenty-one native unit tests, and twenty-seven browser tests pass; the existing NVIDIA hardware unit test and TURN browser check remain opt-in. Web production and native release builds pass. The normal desktop preview is restored without its temporary debugging endpoint.

## AMD/Intel GPU microphone filtering

The Windows desktop offers DeepFilterNet3 through DirectML as a separate optional engine. It runs inside BetterComms without an Adrenalin audio application or virtual microphone. The model and its recurrent state are bundled; explicit setup installs pinned, hash-verified Microsoft runtime components into app-private storage. The installed runtime, model and notices occupy about 49 MB. The one-time upstream package downloads total 215 MB because they contain additional architectures which are not installed.

Native DXGI enumeration selects AMD/Intel hardware explicitly, preferring AMD when both vendors are present. Readiness requires the complete model to run with CPU execution fallback disabled and meet measured real-time timing bounds. Graph transformations, licenses and reproduction instructions are in [AMD model findings](AMD_MODEL_FINDINGS.md) and [DeepFilterNet setup](DEEPFILTER_SETUP.md). No audio leaves the device for processing.

Calls, microphone samples and live loopback use the same 48 kHz mono pipeline, including saved gain/gating and a 0–100 dB maximum-attenuation control. The dry blend includes the model's exact 32 ms delay. A bounded 512-sample Worker/AudioWorklet bridge keeps frame traffic off the renderer. Three native slots accommodate a call, a microphone test and temporary replacement overlap. Failed startup or sustained transport failure explicitly switches to RNNoise while preserving mute. Browser clients normalize this native-only preference to standard browser processing.

Actual Ryzen 7 7800X3D integrated Radeon validation passed: strict GPU-only graph execution, roughly 3.3 ms p95 processing per 10.7 ms frame in the Rust debug runtime, deterministic reset, and noisy-speech output matching the reference within PCM16 quantization. The native WebView test passed 30 seconds of renderer stalls, forced stream shutdown, microphone recapture, RNNoise fallback with mute retained, and resource cleanup. The existing NVIDIA delayed-response hardware check also passed after sharing the transport. Physical voice quality and gaming contention still need listening/load acceptance; Intel hardware has not been physically tested here and remains gated by the same runtime probe.

Final regression: 29 browser tests passed (TURN opt-in skipped), 24 web unit tests passed, and 26 native unit tests passed (three hardware tests remain opt-in; the DeepFilterNet GPU test was separately enabled and passed). Web production and native release builds pass. Native development now requires Rust 1.88 or newer for the pinned ONNX Runtime bindings. The normal desktop preview is restored with temporary debugging disabled.

## Dedicated screen-sharing setup

Native sharing now opens a dedicated `#/share` workspace instead of a modal. Applications and entire displays have a searchable, responsive two-column preview gallery, truncated source titles, and clear selection. The Share/Cancel footer remains visible; desktop quality controls sit alongside the independently scrolling gallery. Narrow windows use one scrolling content area without horizontal overflow. Navigation keeps the call mounted and cancels pending native startup when leaving setup.

Visible source cards request local 640×360 JPEG previews through trusted native IPC. Capture is limited to two concurrent jobs, 512 KiB per preview, and a three-second process timeout; images are not persisted. Unsupported sources show an explicit unavailable state. Encoder and bitrate controls remain available under Stream setup. Native video-only sharing and browser audio fallback limitations remain unchanged.

## NVIDIA screen-detail improvement

The native NVIDIA encoder now uses P5 low-latency tuning, spatial adaptive quantization, and quarter-resolution multipass while retaining zero B-frames and zero lookahead. A controlled 1080p60/20 Mbps dark-detail benchmark showed better decoded precision than the former P4 ultra-low-latency profile. This applies to new NVIDIA shares and their copied native recordings; AMD/Intel encoding and existing assets are unchanged. The reproducible GPU benchmark is `scripts/test-native-encoder-quality.ps1`. It does not establish the cause of a user's specific recording artifacts without the original video.

## Native share audio and preview reliability

Desktop sharing now offers system audio with BetterComms and its WebView process tree excluded through the Windows process-loopback API (build 20348+). System audio remains a separate call and recording track. Capture is bounded, uses binary IPC and an AudioWorklet render clock, and stops with the share. Unsupported systems retain video-only sharing and the browser fallback. This shares all other apps, not only the selected application.

Window preview IDs now remain stable across overlapping refreshes. Binary preview responses are validated with one retry and actionable failure text. Controlled Windows tests verified an actual application-window JPEG and exclusion of a child-process tone while retaining an independent process tone.

## Optional capture border

Native screen sharing defaults to `display_border=0`. The Share screen exposes a Show capture border toggle; its preference persists on this device and is applied to each new native capture. Existing callers that omit the new optional IPC argument also default to border off. Windows can still enforce a capture indicator according to its capture-access rules.

## Speaking activity and connection status

Participant tiles show a green outline when their processed microphone audio is active, with a short release delay to prevent flickering between words. Muting, ended tracks, and leaving the call clear activity. Metering does not play or modify the tracks. The outline indicates microphone activity, not delivery acknowledgement.

The call footer now includes connection signal bars and measured ping. Alone in a room it shows authenticated WebSocket server round-trip time; with friends it shows the highest available connected-peer WebRTC round-trip time. A popover includes recent ping history, average, separate server ping, and each friend's direct/relay route. Missing measurements stay unknown rather than displaying zero. Existing detailed media diagnostics remain accessible.

## Faster source previews and game discovery

The native share picker only schedules thumbnails for visible cards and removes queued work when cards leave the viewport. A picker-local memory cache reuses recent previews across tab/search changes (30 seconds, at most 32 images / 8 MiB); closing the picker releases that cache. Explicit Refresh clears it. Failed captures no longer automatically retry and occupy a second timeout interval. Native one-shot WGC previews request a 30 FPS capture clock instead of 1 FPS, retaining the two-job limit and bounded process cleanup.

Window enumeration includes minimized applications using their normal window dimensions. Sources are ordered by a lightweight executable/window-class heuristic: games and graphics tools, browsers, regular applications, then utilities. This is not GPU activity telemetry or a guarantee of detecting every renderer. Cards identify minimized apps, and sharing restores the selected minimized window; enumerating sources and loading thumbnails never restore windows. Minimized preview requests fail promptly instead of delaying other cards.

Listing a game does not guarantee capture of every exclusive fullscreen renderer. Native sharing continues to use Windows Graphics Capture, not injected game hooks. Microsoft’s [capture sample](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/blob/master/cpp/ScreenCaptureforHWND/README.md) also distinguishes enumeration of minimized windows from capture. Actual Minecraft fullscreen gameplay remains a hardware/application acceptance check.

Native acceptance for this change passed with real Windows capture: monitor preview plus process/timeout cleanup (0.45–0.48 s versus 1.34 s for the prior path on the same fixture), static WPF application preview (1.06 s), and minimized WPF discovery/restore/preview (1.14 s). These are local fixture timings, not a guarantee for every application. The thumbnail graph now scales to 640×360 on the GPU before readback and uses a direct filter source instead of lavfi demuxer probing, which stalled the static-window fixture. JPEG output remains bounded and in memory. Build, 42 frontend unit tests, seven relevant browser tests, cargo check, and 36 Rust unit tests passed; native hardware tests were run explicitly in addition to the ordinary ignored-by-default suite.

## Streaming quality at lower bitrates (2026-09-05)

Native sharing now negotiates High/Main/Baseline H.264 with current viewers and offers an explicit Baseline compatibility override. NVIDIA encoding uses P6 low-latency tuning, spatial/temporal AQ and full-resolution multipass, without B-frames or lookahead. Two-second keyframes reduce repeated intra-frame cost while retaining bounded periodic recovery. The picker adds 8/12/16 Mbps choices and preserves the 20 Mbps default. The live stream and local native recording still share one encoder.

The repeatable 1080p60 synthetic benchmark improved VMAF from 91.814 to 94.247 at 8 Mbps and from 95.334 to 96.860 at 12 Mbps, at comparable measured output bitrates. Actual native capture, Chromium decode and MP4 profile/dimension inspection passed all nine combinations of Baseline/Main/High and 8/12/20 Mbps. Baseline8 and Main8 passed induced encoded-frame loss recovery and late joining. This establishes local hardware compatibility, not cross-network or game-content parity with Discord.

Recording finalization drains queued access units and reports bounded muxer diagnostics; a recording stopped before its first IDR explicitly reports that no decodable frame arrived. Final regression checks: production frontend build, 46 web unit tests, 44 Playwright tests (one optional TURN test skipped), and 37 Rust tests (eight opt-in hardware tests ignored). See NATIVE_SHARING.md for benchmark details and limitations.

## Hosted preview and distributable builds (2026-09-05)

The public GitHub repository is InfinityZ25/bettrcomms. Railway hosts the Vite production UI and Go API on one HTTPS origin, with a separate persistent PostgreSQL service. The repository is linked, but deploys currently use the authenticated Railway CLI; automatic push triggers are not active. Development authentication is disabled remotely, cookies are Secure/HttpOnly, and WorkOS's existing staging environment retains both localhost and hosted callbacks. No Vercel service is needed.

Desktop releases load the exact hosted origin and grant only that origin the explicit native command permission. A packaged Windows smoke test verified native capability IPC and WorkOS login initiation, and verified that the external authentication page cannot invoke native commands. This does not establish completion of an interactive user login or a system-browser OAuth return flow. macOS uses browser device permissions rather than Windows-only permission IPC.

Windows NSIS packaging and local hosted startup passed. GitHub Actions builds Windows x64 and macOS Apple Silicon/Intel installers; consult the workflow for each final revision's actual outcome. Initial artifacts are unsigned and Mac builds are not notarized. macOS physical-device media behavior, production TURN, and packaged runtime distribution remain the limitations in DEPLOYMENT.md. The hosted and localhost origins have separate local recording libraries; this deployment does not migrate local accounts, chat, or recordings into the hosted environment.

## Native screen delivery smoothness (2026-09-07)

Native sharing previously handed every access unit to one shared WebRTC track, which serialized packet writes across all viewers on the encoder's own output thread. One congested viewer could back up that thread, fill the FFmpeg output pipe and drop frames for everyone, including the sender's local preview. Each viewer now owns a track, a bounded queue and a paced writer task; the encoder thread only enqueues. A viewer that cannot keep up drops its own frames and resumes at the next keyframe, reported per viewer as `droppedFrames` in the existing screen diagnostics. New viewers start on a keyframe instead of mid-GOP.

Packets now leave through a leaky bucket at 2.5 times the selected bitrate, so a two-second keyframe spreads over milliseconds instead of arriving as one burst. The rate-control buffer changed from a half-second VBV to about a tenth of a second, never less than two frame intervals. A measured 1080p120 NVENC capture at 20 Mbps kept an identical keyframe cadence and mean frame size (20 943 versus 20 963 bytes) while its largest frame fell from 147 031 to 115 511 bytes. NVENC keyframes are now explicitly forced as IDR rather than relying on the GOP boundary.

RTP timestamps follow the encoder's output clock instead of a nominal `1/fps` step per access unit, so an encoder that transiently falls behind no longer drifts the receiver's playout away from wall time. The offer advertises only the feedback this sender acts on — NACK, PLI and FIR — and no longer advertises transport-wide congestion control it never populated, nor duplicate NACK feedback lines.

A viewer whose direct native connection fails still falls back to the sender re-encoding its decoded preview through the ordinary call. That fallback was previously visible only inside a diagnostics list; affected screens now carry a "Reduced quality" badge on the tile and on the stage.

This does not add congestion control: the selected bitrate is still fixed for the session, and PLI still cannot force an IDR, so a viewer that starts or loses data waits up to two seconds for the next scheduled keyframe. Both need the encoder to move in-process and remain open.

Validation: 65 native tests pass, including a new loopback test that runs an actual DTLS/SRTP peer connection and confirms a fragmented keyframe reassembles byte for byte with 750-tick spacing at 120 FPS, and a test that a stalled viewer drops its own frames without blocking capture. Encoder argument changes were measured against real NVENC through the packaged FFmpeg 8.1. Frontend build, 103 web unit tests, 82 Playwright tests (one skipped) and `go test ./...` with `go vet ./...` pass. One voice-relay browser test first failed on the local auth rate limiter after a back-to-back suite run and passed on its own; see AGENTS.md on not running suites concurrently. Cross-network behaviour and sustained gameplay load still need hardware acceptance.

## Screen delivery on every route (2026-09-07)

Following the native sender rework, the remaining send and receive paths were measured and corrected.

**Recovery interval.** Native keyframes moved from two seconds to one. A VMAF comparison of both intervals at 1080p across 60 and 120 FPS and 8 and 20 Mbps put every pair within 0.16 VMAF, with measured output rates matching the target to within 0.03 Mbps and the sign reversing on a repeated run. The interval has no measurable quality cost in that range, so the shorter recovery is taken. A real 1080p120 capture confirmed IDRs at exactly one-second spacing with an unchanged mean frame size and 19.95 Mbps delivered. This halves the worst case for a viewer that joins or loses data; it does not replace answering a PLI.

**Resuming a paused view.** An unwatched share previously detached its decoder. Resuming then needed a keyframe the native sender cannot produce on request, which is the main reason the same share looked perfect once and stuttery the next time. The frozen tile now keeps the track attached and decoding and paints a still frame over it, so only the picture is frozen. The stream arrives whether or not a tile paints it, so this costs decode, not bandwidth.

**Browser sharing.** Browser screen tracks now declare `contentHint`, and every screen sender sets `degradationPreference`, not only the native compatibility path. Chromium previously treated a shared screen like camera video and traded resolution away first, which is the wrong degradation for text. Capture constraints now follow the configured stream quality instead of a hardcoded 60 FPS ceiling, and Stream quality offers a 120 FPS ceiling for high-refresh displays.

**Local preview.** The sender's own preview connection never leaves the machine, so it is no longer paced; pacing a loopback path only added latency.

**A viewer the fixed bitrate does not fit.** The native encoder has no congestion control and one rate for every viewer, so a link that cannot carry that rate previously stayed broken indefinitely: the no-media timer only catches a stream that never arrives, not one that arrives and cannot be sustained. Each receiver now measures its own two-second windows of unrecovered loss and freeze time and, after three consecutive bad windows, moves itself to the compatibility route, which is lower quality but runs under the browser's own rate control. The switch is one-way, needs six seconds of sustained trouble, ignores windows carrying fewer than 100 packets, and marks the screen "Reduced quality". This changes the route, not the encoder.

Not addressed, and still open: the selected bitrate is fixed for the session, and PLI cannot force an IDR. Both need the encoder to run in-process. The packaged runtime is a single statically linked `ffmpeg.exe` pinned by exact length and SHA-256 and verified in CI, with no shared libraries or headers to link against, so this is a packaging migration rather than a code change. webrtc-rs 0.17 also ships no bandwidth estimator, so congestion control needs one written before any transport-wide feedback is worth advertising. Routing a share through the server instead of peer-to-peer remains planned as a later native sharing setting.

Validation: 64 native tests, 105 web unit tests, the frontend production build, `go vet ./...` and `go test ./...`, and the Playwright suite pass. Encoder changes were measured against real NVENC through the packaged FFmpeg 8.1. The browser assertions cover synthetic media; they do not prove native capture or cross-network behaviour.
