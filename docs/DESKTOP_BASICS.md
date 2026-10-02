# Desktop basics

Settings → Desktop contains launch at login, global call shortcuts and verified
updates. All native methods require the per-launch trusted-page token. The web
client cannot register login items, monitor global input or replace executables.

## Call shortcuts

Mute and deafen shortcuts are unassigned by default. Assign a physical keyboard
key or mouse button; each shortcut must differ from push-to-talk and the other
action. Escape, Tab and Windows/Command are reserved. Press once to toggle;
key repeat and duplicate native snapshots do not toggle again. Mute/deafen
continue to override push-to-talk. Deafen also updates local call playback.

One observer watches at most three selected bindings during a call. It never
records characters, forwards unrelated keys, intercepts shortcuts in other apps
or adds an idle background observer. The existing lease, heartbeat and fail-closed
PTT behavior remain in use. The DOM handles foreground input and the native
observer handles background input, avoiding two toggles for one key press.
Typing and shortcut assignment follow the existing in-app input preference.

Windows uses the existing low-level keyboard/mouse hook worker. macOS uses a
listen-only CoreGraphics event tap on its own run loop, with events filtered to
the selected keys/buttons before crossing into Go. It requires Input Monitoring
permission. “Allow input monitoring” requests consent only after an explicit
click. Grant permission in System Settings → Privacy & Security → Input
Monitoring, then restart BetterComms and rejoin the call. Denied/revoked
permission falls back to foreground input; it never leaves PTT transmitting.
macOS remains reported experimental until acceptance on an actual Mac.

Physical acceptance still required: left/right modifiers, ANSI/ISO keyboard
layouts, mouse buttons 0–4, hold/release while changing focus, OS consent denial
and revocation, sleep/wake, leaving/rejoining calls and two foreground key events
without a duplicate toggle. Windows unit tests exercise actual hook registration,
leases and cleanup, but synthetic tests do not prove a particular user's hardware.

## Launch at login

Off by default and unavailable in development. Windows writes only the current
user's Run value named BetterComms-Wails, with the exact quoted executable path.
Another installation's value cannot be overwritten or removed. The installer
removes only its own matching value on uninstall.

macOS uses SMAppService.mainAppService for the installed com.bettrcomms.wails
bundle. The OS may require approval in General → Login Items. The app reports
that pending approval instead of claiming launch is enabled. Login/reboot and
unregister behavior require acceptance using an installed, signed app on macOS.

## Verified updates

Update checks are disabled in development and when the release build lacks public
configuration. Automatic checking is opt-in, checks after one minute and then at
most every six hours while running. Download and restart always require a click.
Calls, captures, recordings and exports block restart. A page activity lease
covers browser-mediated calls; native managers independently report active work.

The feed is a signed envelope containing base64 JSON payload and its Ed25519
signature. The manifest contains a separate Ed25519 signature over each artifact's
SHA-256 digest. Both signatures and the digest are mandatory. Expired, future-dated,
oversized, ambiguous-platform and older releases are rejected. The highest accepted
version is persisted under the user's BetterComms configuration directory to reject
rollback across app restarts. The same user's ability to replace their app or modify
their local configuration is outside that protection.

Requests use HTTPS on port 443 without credentials. Feed and redirect/download
hosts are pinned at build time; metadata cannot expand the allowlist or change
the key. Feed size is at most 256 KiB and artifacts are at most 300 MiB, streamed
without reading the artifact into memory. A partial, oversized or changed staged
Windows executable cannot be installed. Metadata expiry is checked again at
download and restart; recheck when a staged release has expired.

Windows updates require a raw Authenticode-signed host EXE, verified by
WinVerifyTrust without UI and with certificate-chain revocation checking.
An installer EXE is not a self-update artifact. This replaces the host and its
embedded frontend, while preserving FFmpeg, optional DSP runtimes, profile,
credentials and recordings. Changing those bundled runtimes still requires the
full installer. The installer's DisplayVersion is updated by a full installer;
the app itself reports its current host version after a host-only update.

macOS updates require a ZIP containing a single BetterComms.app, signed with
Developer ID using the pinned Team ID and accepted by Gatekeeper/notarization.
codesign verifies the application identifier, Apple trust anchor, Team ID and
strict bundle signature before restart. A DMG or ad-hoc signed bundle is not
accepted as a self-update artifact. The updater ZIP extraction also enforces
Wails' archive limits and traversal checks.

## Publishing prerequisites

The existing packaging scripts produce an unsigned Windows distribution and an
ad-hoc signed macOS DMG. They do not yet publish a signed update feed. Updates
therefore remain unavailable in those builds until a release owner configures
real signing and publishes compatible artifacts. No production private key,
Authenticode certificate, Apple signing account or release credentials were
created or embedded by this implementation.

Create an Ed25519 signing key outside tracked files, for example in root .local/
which is private. Run from apps/desktop-wails:

```sh
go run ./cmd/update-feed -generate-key -key ../../.local/update-signing.pem
```

The command prints only the base64 public key. Store the private key in a release
signing secret store; never put it in Git, VITE variables, a feed or build flags.
Build scripts accept these public settings:

| Variable | Value |
| --- | --- |
| BETTERCOMMS_BUILD_UPDATE_FEED | HTTPS URL to the signed stable envelope |
| BETTERCOMMS_BUILD_UPDATE_PUBLIC_KEY | Base64 Ed25519 public key, 32 bytes |
| BETTERCOMMS_BUILD_UPDATE_DOWNLOAD_HOSTS | Additional allowed hostnames, comma-separated, including actual CDN redirect hosts |
| BETTERCOMMS_BUILD_UPDATE_MAC_TEAM_ID | Ten-character Developer ID Team ID, required on macOS |

The feed host is automatically allowed. The build helper rejects incomplete,
insecure or injectable configuration. Values are linked into the host; runtime
environment and page input cannot replace this trust root. Do not put private
GitHub tokens in URLs. Public HTTPS object storage or a public release download
can serve the artifacts; allow only the actual hosts used by that provider.

Prepare manifest JSON with schema 1, channel stable, a newer numeric major.minor.patch
version, UTC publishedAt/expiresAt, notes and artifacts. Expiry must be in the
future, at most 31 days away and after publication. Each artifact specifies
platform (windows/darwin), arch (amd64/arm64), filename and HTTPS URL. Filename
must be a basename ending in .exe for Windows or .zip for macOS, without “setup”.
The signing tool fills size, sha256 and signature from the local artifact file.

Sign OS artifacts first, then create the envelope from their final bytes:

```sh
go run ./cmd/update-feed -key ../../.local/update-signing.pem -manifest ../../.local/release.json -artifacts ./bin/releases -out ../../.local/stable.json
```

For macOS, sign/notarize/staple BetterComms.app and package it with
ditto -c -k --sequesterRsrc --keepParent before signing the update manifest.
Publish artifacts first and the signed stable.json last, atomically. Refresh
the signed manifest before expiry even when retaining the same release version.
Key rotation needs a release that embeds the new key; an untrusted feed cannot
rotate it. Never publish the current unsigned installer/DMG as a workaround.

## Verification boundaries

Focused tests cover native page authorization, shared input action/debounce
semantics, PTT/mute/deafen priority, startup command validation, signed feed
tampering, key substitution, replay/downgrade, bounded/truncated downloads,
staged digest changes, unsigned artifact rejection and restart activity guards.
Build-configuration tests reject malformed public settings.

Actual Developer ID/AuthentiCode signing, notarization, production publishing,
installed self-replacement and macOS CGO frameworks cannot be accepted by tests
on this Windows checkout. Run macOS CGO compilation on a Mac, then two-version
signed update acceptance on both operating systems, including interruption,
disk-space failure, denied OS trust and recovery. A CGO-disabled cross-compile
only verifies portable fallback code; it does not compile or prove event taps
or login items.
