# Daily communication

The browser and Wails frontend share these flows. Native transport continues to
use the authenticated desktop API boundary; no browser-only auth bypass is added.

## Profiles and status

Profile settings edit the public name, unique username, photo and description.
WorkOS and development sign-in preserve these edits. Photos continue to use the
existing bounded PostgreSQL avatar storage, independently of S3.

Open a profile from a message author, friends list, activity item or your account
menu. The card exposes public identity, effective availability, custom status,
shared conversations and mutual friends. Self, friends, pending friend requests
and current shared membership are the authorized relationships. Blocking or
losing the last relationship revokes access. The public endpoint excludes email.

Custom status has text, an optional Unicode emoji and a clear-after preset.
Expiry is enforced on reads, by one client expiry timer and by bounded server
cleanup. Live updates reuse the existing authenticated account socket.

## Messages and activity

Record a voice note explicitly from the composer, stop and preview it locally,
then attach and send. Discarding or changing conversation releases the recorder.
Its microphone is independent of call mute/PTT. The maximum is two minutes and
10 MiB; audio-only WebM/Opus and MP4/AAC or Opus are validated on the server,
including MP4 fragment timing. Received audio loads its private signed URL only
after choosing Listen. The existing S3 configuration is required for delivery.

Conversation menus add/remove favorites and archive/restore private messages
and groups. These preferences persist per account and synchronize across its
sessions. Archive hides a conversation from Active without changing membership,
message history, notification rules or access to an ongoing call.

Activity shows mentions, replies (including threads) and pending friend/message
requests. Opening an item navigates to its exact message and thread; requests can
be accepted or declined. Permissions are rechecked server-side on every page.
The view loads only while open, with cursor pagination, a 300-item client bound,
and debounced refreshes through the existing socket rather than polling.

Emoji search retains the Unicode catalog and adds account-scoped recent choices,
skin-tone filtering, search clearing and keyboard navigation. The full catalog
remains lazy-loaded; recent history is bounded to 24 choices per account.

## Preference synchronization

Enable **Settings → Appearance → Sync preferences** separately on each device.
Portable fields are theme, camera placement, voice balancing, app sound enablement,
volume and individual sound choices. Writes are sparse, debounced and versioned;
concurrent edits merge with bounded retries. Devices, microphone processing,
PTT keys, OS permissions and notification permissions remain local.

## Validation boundary

Migration `013_daily_communication.sql` adds the persisted status and preferences,
voice metadata and activity indexes. Browser acceptance uses real API/PostgreSQL
and synthetic media. Local voice acceptance additionally uses an isolated Docker
S3-compatible service, with a real Chromium MediaRecorder file. These checks do
not prove microphone permission or MediaRecorder compatibility on physical macOS,
packaged WorkOS sign-in, or cross-network voice connectivity.

The browser CI job provisions disposable MinIO storage on loopback with fixture
credentials, then runs the same private upload/playback test. Production keeps
the existing `AWS_S3_BUCKET`, `AWS_REGION` and AWS credential-provider configuration.
Local S3-compatible acceptance can additionally set `AWS_ENDPOINT_URL_S3`; it
does not require changing production credentials or bucket permissions.
