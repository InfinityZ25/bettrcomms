# Personal characters

Personal characters give each account a recognizable presence beside its photo.
They use the existing Blobatar generator and current parameter ranges. This
feature does not reserve globally unique drawings or claim that every pair of
characters is perceptually distinguishable.

## Account appearance

Settings → Profile → Your character presents six account-derived choices and
automatic color plus six color presets. A greeting preview stays local. Save
persists the selection; Discard restores the current saved choice. A newer
profile update from another device requires loading that choice before saving
an older draft. The character is also presented in profile details.

The stored appearance is `{ "variant": 0, "hue": null }` by default. `variant`
accepts integers 0–5; `hue` accepts an integer 0–359 or `null` for automatic
color. Variant zero uses the original account seed and retains its original
automatic color. Other variants derive deterministic seeds from the account ID.
Variant labels represent generated alternatives, not six fixed anatomy types.

`PATCH /api/v1/me/character` requires both fields in a JSON object. It accepts
no arbitrary SVG or image content. The server validates the input, shares the
profile-change rate limit, increments `profile_version`, and distributes the
updated user through the existing `user.profile` flow. Profile photos remain
independent. Existing API user snapshots populate a version-aware character
cache; rendering a character does not make its own account query. Account
changes clear the cache.

Direct conversation headers reuse the verified account identity from already
loaded members. Navigation uses conversation or group icons rather than
generating a different person's character from the conversation ID. These icons
add no member queries or subscriptions that would retain message histories.

Direct-conversation headers use the other account's photo and character only
when existing cached membership identifies exactly that person and the signed-in
viewer. Unknown conversations and navigation lists use a neutral conversation
icon; groups use a group icon. Lists do not subscribe to histories or keep them
loaded just to show an avatar. A conversation ID is not a personal character
seed, and these surfaces do not make additional membership queries.

## Calls

Media still uses per-device peer IDs. Character identity uses the account ID
provided by authenticated signaling, so reconnection or another device does not
generate a different person. Known user snapshots also supply the current name,
photo and saved appearance.

With the camera off, the character occupies the tile's main media area. With a
camera on, it moves to a smaller position in a reserved identity footer beside
the photo and name. The footer does not cover the camera image. Screen shares
retain their existing content layout.

A confirmed local join and new live remote membership can issue a one-shot
arrival token with an `arrivalAt` timestamp captured at the event. Initial peer
snapshots and signaling resume identify people
without greeting them again. A second connection for an already represented
account does not introduce another social arrival. Arrival bursts are limited
to two within a 1.5-second window. Layout remounts consume the same tokens rather
than replaying them. A figure first rendered more than 1.5 seconds after its
arrival consumes the token without playing a late greeting.

The character's speaking response uses the existing boolean voice state and a
small CSS transform. It adds no microphone capture, audio analyser, media track
or per-sample React update.

## Conversation activity

The character button in the main and thread composers offers Wave, Nod and
Celebrate. Sending is explicit and disabled while offline or otherwise unable
to post. Successful sends start a three-second local cooldown. A failed request
shows its error rather than adding a synthetic message.

`POST /api/v1/rooms/{room_id}/character-gesture` accepts a supported `gesture`
and optional `thread_root_id`. The server applies room posting authorization,
including membership, private reads, blocking, posting restrictions and slow
mode. Thread gestures require an undeleted root in that conversation. Rate
limits allow one gesture per three seconds and at most 30 per minute per user.

Authorized gestures fan out as live `character.gesture` events. They bypass
durable message/event history and do not create unread counts or notifications.
The client shows up to two gestures per conversation/thread scope for four
seconds from receipt. It deduplicates event IDs, replaces a sender's active
gesture, and clears transient gestures on disconnect or account change. There
is no reconnect replay. Thread activity stays in its thread.

The reserved live activity row otherwise shows up to three typing characters
and a count for additional people. Gestures temporarily take that row's place.
Photos stay with historical messages. Textual activity remains available when
motion is disabled.

## Screen companion

Your own character also lives on the screen as a companion
(`apps/web/src/features/pet`). It is on by default; Settings → Appearance →
Screen companion turns it off or changes its size on that device. Phones draw
it at three quarters of the chosen size.

**Where it stands.** Elements marked `data-pet-perch` are surfaces it stands on:
the composer (`composer`, in the reserved activity row above the well) and a
call's controls (`call`). Other screens offer their `.content-canvas`, where it
sits inside the bottom edge; with nothing else, the bottom of the window. The
focused composer wins, then any composer, then a call, then the canvas. It
follows navigation, focus and resizes by hopping to the new surface. Surfaces
are read when it decides where to go, after clicks/focus/resizes and from a
`ResizeObserver` on the current one — never per frame. A spot you drop it on is
remembered per surface kind (`bc-pet-home`).

**Who it is.** Temperament is a pure function of the character seed, hashed
separately from the generator's 32-bit state: energy, curiosity, affection,
mischief and shyness, plus one of six signature moves (backflip, spin, melt,
pogo, jelly wobble, ta-da). Profile settings show the leading traits for every
variant, so choosing a creature also chooses how it behaves. Temperament
weights what it does when nothing is happening (sit, glance, wander, nap,
stretch, explore, hum, signature move), how fast and high it hops, how long it
rests, how far away it notices the pointer, and how it reacts to everything
below.

**What it notices.** The realtime socket, the call session and the composer
emit small signals (`features/pet/signals.ts`); with the companion off nothing
subscribes and nothing is queued.

- A message in the conversation you are looking at: a glance and a perk. A
  message elsewhere: a "!" towards the sidebar. A mention: a startled jump.
  Your own message: a happy hop. A failed send: a sad shrink and a sweat drop.
  A busy conversation only gets glances: the body reacts again after 20 s of
  quiet in the open conversation (8 s elsewhere). While asleep, only a mention
  wakes it.
- Someone typing in the open conversation: a speech bubble with dots, once per
  person per typing session, looking towards the activity row.
- While you type, it watches the composer.
- A friend coming online: a little tune, at most every 30 s.
- Joining or leaving a call, someone joining it; while you speak, it talks
  (mouth and bounce driven by the call's existing speaking state); while
  someone else speaks, it looks at the stage.
- A gesture you send: your companion performs it. A gesture a friend sends in
  the open conversation: **their** companion drops in beside yours, performs
  it, the two bump, and it leaves. One visitor at a time; the visit is local
  and adds no network traffic beyond the existing gesture event.

**What you can do with it.** Click to boop it (the reaction depends on its
temperament; five quick boops make it cross), double-click for its signature
move, stroke it back and forth to pet it, or drag it and let go to throw it.
A thrown companion flies with gravity, bounces off the window edges, lands on
whatever surface is below and gets dizzy if it landed hard. Interactions are
pointer-only decoration: the companion is `aria-hidden`, and gestures remain
available from the composer's gesture button, which shows a hand while the
companion is on screen.

**When it rests.** After 75 s without input it falls asleep and wakes with a
stretch when you come back. Sleepy temperaments also nap on their own, more
at night. Leaving the app for more than three minutes earns a welcome; the most
important thing that happened while away (a mention, a gesture, a message) is
shown on return instead of being missed or replayed in full.

### Companion resource rules

- The generator's infinite idle loops (breathe, bob, blink, saccade, rock,
  shake) are switched off inside the companion. Life is drawn in bursts: a
  blink, a breath or a glance every few seconds, separated by nothing at all.
- Walks, hops, squash and stretch are Web Animations on `transform` of HTML
  wrappers. The only per-frame JavaScript is a thrown companion's flight, which
  stops when it lands and is capped at four seconds.
- React renders the creature once per character and size; the engine moves its
  wrappers directly. Expression changes are the only re-renders.
- Window blur, a hidden document and fullscreen freeze it completely: tasks,
  animations, timers, emotes and the gaze driver stop. Asleep for more than
  24 s, it keeps no timer at all; a nap that ends while you are still away
  silently becomes sleep instead of waking up to an empty room.
- At most one behaviour timer and one "life" timer are pending; at most four
  emotes and one visitor exist at once.
- The code is a separate chunk fetched when the browser is idle after sign-in,
  and only when the companion is on.
- Character motion off keeps it in place with expressions only; the system
  reduced-motion preference also stops blinks, gaze and emote animation.

## Motion and resource boundaries

Settings → Appearance → Character motion is a device-local preference. Turning
it off preserves the characters and textual cues while suppressing movement.
The operating system's reduced-motion preference takes priority over the app
switch. The preference is saved in local storage and follows storage updates
between tabs on that device.

The SVG geometry stays static. Arrival and gesture animations change only the
outer wrapper's transform and opacity and last under one second. At most two
event animations run concurrently. Events received while quiet or hidden are
consumed rather than queued for later animation. Offscreen figures do not start
an event animation. Visibility changes cancel active event animations, and
component disposal cancels its animation. Ordinary avatar lists do not run
continuous Blobatar animation.

Animation startup and disposal use cancelable microtasks. Ownership follows the
DOM node and event, so React Strict Mode can replay refs even after startup
without canceling the surviving animation. A different node still consumes the
global event token without replaying it. Final subscriber cleanup releases the
shared listeners. There is no animation polling loop or recurring motion timer.

These are implementation bounds, not a measured CPU, GPU, battery or frame-rate
guarantee. Compare an otherwise identical call with motion enabled and disabled
before making a performance claim. Native capture, GPU encoding, packaged auth,
physical devices and cross-network connectivity retain their separate gates.

## Local setup and validation

Migration `server/migrations/022_personal_characters.sql` adds constrained
`users.character_variant` and nullable `users.character_hue` columns. Existing
accounts default to their original appearance. The API reexecutes all migration
SQL files on every startup; migration 022 uses `ADD COLUMN IF NOT EXISTS` so
restarting preserves the saved selection. Restart the local API before testing
these endpoints. Use the existing Docker PostgreSQL development infrastructure and the opt-in,
loopback-only development authentication described in the root README.

For local review, start with `./scripts/start-api.ps1 -DevAuth`, open the web
app's root URL, and use **Enter local workspace** with a name and test email.
This is separate from **Continue with WorkOS**, which requires WorkOS
configuration. The local form is presented first and does not require scrolling
past the signed-out home screen.

The relevant automated checks are:

```powershell
npm run build
npm test
npx playwright test tests/personal-companions.spec.ts
Push-Location server
# Set TEST_DATABASE_URL to the existing local Docker database.
go test ./...
go vet ./...
Pop-Location
```

Run browser suites sequentially against the local auth rate limiter. The
Playwright scenarios use the real local API/database and synthetic camera and
microphone devices; they do not establish physical or packaged acceptance.

Acceptance should verify saved appearance after reload, profile updates across
devices and friends, photo preservation, account identity through call resume
and rejoin, camera footer separation, thread-only gestures, unchanged message
history, cooldown/error behavior, reduced motion, persisted quiet mode and
narrow layouts. Unit and database tests cover generation defaults, bounds,
version ordering, arrival rules, transient state and authorization. These are
the intended checks; their presence alone is not a passing validation report.

## Local validation — 2026-10-18

The final implementation passed:

- `npm run build`.
- `npm test -w apps/web -- --maxWorkers=4`: 103 files, 709 tests. An earlier
  unrestricted run under simultaneous build/analysis load timed out in an
  existing recording-conversion test; the final full run above passed without
  changing that test or its timeout.
- One sequential Playwright run covering `personal-companions`, `call-layout`,
  `call-presence-ui`, `call-view-switching`, `signaling-resume` and
  `speaking-activity`: all 11 scenarios passed. This includes completed greeting
  animations, camera/footer separation, mobile layouts and preserved voice
  playback while navigating.
- After the local sign-in visibility fix, four additional browser scenarios
  passed: sign-in through the actual form on desktop and mobile, public-screen
  accessibility at three viewport sizes, and switching accounts without reload.
- `go test ./... -count=1` with the local Docker `TEST_DATABASE_URL`, plus
  `go vet ./...`. The migration-replay test passed after making 022 idempotent.
- `git diff --check` and React Doctor's changed-file scan including untracked
  source: zero errors. Its two loading-reset warnings were reviewed as false
  positives: both resets already occur in `finally` and skip disposed owners.

Mobile call and chat screenshots were visually inspected. This validation used
synthetic browser media and does not measure hardware resource consumption or
establish native/packaged acceptance. Changes remain local on
`feature/personal-companions`; no push or deployment was performed.

## Screen companion measurement — 2026-10-20

Method: the production build (`vite preview`) against the local API, one open
direct conversation with a few messages, 1280×800, headless Chromium through
Playwright on an Intel Core i7-12700H. After a short settle, a 15-second
Chromium trace (`devtools.timeline`) counts drawn frames and paints, and the
DevTools `Performance` metrics give main-thread task time. Each scenario uses
a fresh account, so each companion has a different temperament; busier
temperaments land at the high end.

| Scenario (15 s) | Frames drawn | Paints | Main-thread tasks |
| --- | ---: | ---: | ---: |
| Companion off | 0 | 0 | 12–18 ms |
| On, you are reading (no input) | 53–79 | 48–72 | 55–112 ms |
| On, you are using the app (pointer moving) | 306 | 76 | 179 ms |
| On, app in the background (blurred) | 0 | 0 | 10 ms |
| On, asleep after you left | 0 | 0 | 27 ms |

The measurement found one problem, fixed before these numbers: a nap that
ended while nobody was there woke the companion into another round of Zs and
breaths (632 frames per 15 s while "asleep"). Reviewing it also led to the
reading calm-down and to glances instead of hops in busy conversations; the
busy-conversation case itself was not measured. Development builds cost
several times more (React development mode); only production numbers are
reported.

These are local, synthetic measurements on one machine. They do not establish
GPU, battery or thermal behaviour, physical displays, the packaged desktop
app, or low-end hardware.

## Screen companion validation — 2026-10-20

- `npm run build`; `npm test -w apps/web -- --maxWorkers=4`: 107 files, 732
  tests, including the companion's personality, decision, flight and face
  geometry tests.
- Sequential Playwright runs: `screen-companion` (perching on the composer, boop,
  mention, a friend's visit, no running animation once settled, frozen while
  hidden with the mention shown on return, temperament in settings, switching
  it off), `personal-companions` (now reading your own saved appearance from the
  screen companion), `call-layout`, `call-presence-ui`, `call-view-switching`,
  `signaling-resume`, `local-sign-in` and `accessibility` against the production
  build, and `speaking-activity` against the dev server it imports from.
- The accessibility run found a `div` with an `aria-label` and no role in the
  live activity row; it is now a labelled group.
- Desktop dark and light, a call with the conversation beside it, and a phone
  viewport were inspected from screenshots. Backend code was not changed.
