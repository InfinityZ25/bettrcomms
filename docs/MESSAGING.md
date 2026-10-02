# Messaging

Direct/group conversations and room chat share the same message controls. Open a
direct conversation from Messages; open room chat with **Room messages** in
the lobby or **Chat** in the call toolbar. Opening chat does not join or leave a call.

- Navigation badges show unread messages; `@` means at least one mentions you.
  Pick a member from the composer after typing `@` to create a mention. Read
  cursors persist per account/conversation and synchronize across devices.
  An open, focused conversation marks the latest messages read when the bottom
  is visible. **Mark as read** also works when browsing older messages.
- History loads in pages of 50. **Load older messages** preserves scroll
  position, and **Jump to latest** restores following new messages.
- **Search messages**, the desktop search control, or Ctrl/Cmd K opens search.
  Filter by conversation and author; **Find person** looks up an author by name
  or email without loading every conversation. Conversation search lists its
  members. Search uses PostgreSQL full-text words/phrases rather than arbitrary
  substrings. **More results** pages through matches. Distant results appear
  separately from recent history; load older pages for surrounding context.
- Own messages can be edited or deleted with confirmation. Editing preserves
  the message ID and shows an edited marker. Deletion clears stored body,
  mentions, reactions, search content and reply previews, retaining a tombstone.
  Deleted messages cannot be edited or reacted to. Other participants cannot
  edit or delete someone else's messages.
- Reply quotes link to the original message and follow its edits/deletion.
  Eight emoji reactions are available; clicking your reaction removes it.
- Messages render HTTP(S) URLs as external links. Images load only when near
  the visible history; audio and video load on request, with download separate.
- Direct messages require an accepted friendship or message request. Receiving
  requests is off by default and can be enabled in Friends → Message privacy.
  A request carries one text message; accepting opens a direct conversation
  with that message. Blocking removes friendship and requests and revokes the
  existing direct conversation for both people. Unblocking does not restore it.
  Blocking leaves shared group DMs and removes live access. Shared channel
  membership is unaffected by a personal block.

## Profiles, availability, groups and invitations

- **Settings → Profile** edits display name, a unique username, bio and photo.
  PNG/JPEG photos up to 2 MB and four million pixels are cropped/resized to
  256 px before upload; the API accepts up to 256 KiB and revalidates the image.
  Profile photos use authenticated PostgreSQL-backed storage, so they do not
  require S3 credentials. Changes update contacts, loaded authors and account
  sessions through versioned realtime events.
- **Account status** in the account menu or Profile settings selects Online,
  Away, Do not disturb or Invisible on every device. Away is manual. Invisible
  hides online presence, not participation in shared calls. DND silences alerts
  and Web Push while retaining message delivery and unread counts. The device
  quiet toggle remains independent.
- **Messages → New group** selects one to nine accepted friends. Owners rename,
  add and remove people in **Group info**; members have access to its history
  and calls. Leaving as owner transfers ownership to the earliest remaining
  member. Removing/blocking a member revokes HTTP and live access. Blocking
  someone leaves groups shared with that person; unblocking does not rejoin.
- **Room settings → Invitation links** is available to channel owners. Set
  expiry (up to 30 days, or never) and maximum joins (up to 1000, or unlimited).
  Copy the new link before closing; existing links show metadata and revocation
  only, as the server keeps hashes rather than reusable plaintext tokens.
  A room can have up to 20 active links; active links remain visible before
  the bounded history of revoked/expired links.
  Anyone with a valid link can sign in, review and explicitly join that room,
  including its history. **Calls → Join with link** supports pasted links in
  both browser and desktop. Existing members do not consume additional uses.

## Implementation and limits

Migration `003_messaging.sql` upgrades existing messages without discarding
them. Server-assigned sequences make equal-timestamp pagination deterministic;
monotonic read cursors cannot move backward. Mutations validate membership and
ownership in Go, including membership locks during writes. Search is restricted
to conversations the requesting user can read and has a per-user rate limit.

The existing authenticated event stream delivers `chat.message`, `chat.updated`
and `chat.read`; no polling loop or additional socket was added. HTTP reconciles
history after reconnect and invalidates inactive caches. Only opened histories
are retained, with at most twelve inactive conversations; a long active history
grows only as the user requests older pages. Unread refreshes coalesce bursts.
Requests and UI observers/listeners are released on close or account change.

Migration `004_messaging_complete.sql` adds send idempotency keys, attachment
metadata, reports, moderation audit records, and room notification preferences.
The composer retries a send with the same key so an uncertain response does not
make a duplicate message. The active conversation fetches missed new messages
by sequence after reconnect. Edits and reactions on older, unloaded messages
are visible when that part of history is loaded; this is not yet a durable
event-by-event replay for every historical mutation.

Choose up to four files of 10 MB each from the composer or drop/paste them.
Images, audio, video, plain text, PDF, and ZIP/Office files are accepted after
server-side type detection; executable and active web formats are rejected.
Uploads remain private in S3 and are readable only to current conversation
members through five-minute signed URLs. An attachment waiting more than 24
hours for a message and attachments from deleted messages are removed by a
periodic cleanup. The file picker remains visible without S3 configured but
reports the missing configuration when used. Type checks do not replace malware
scanning, which remains a production gate.

Draft text persists per account and conversation on this device until sent,
including across browser restarts. Uploaded attachment references expire from
the draft after 24 hours. A local File object must be chosen again after a
reload if its upload did not finish. Typing is ephemeral over the existing
WebSocket. A divider marks the first unread loaded message. Right-click a
conversation to select all notifications, mentions only, or mute. Do Not
Disturb and system notification opt-in are device-local in Settings;
browser notifications work while the web app is running. With VAPID configured,
the browser also registers a per-device Web Push subscription so notifications
can arrive after the tab closes. Push sends a generic message notice without
message content and rechecks room access, mute/mentions, and Do Not Disturb
before delivery. Web Push still displays when another account or sign-in tab is
open; page and push alerts use the same per-room tag to avoid duplicate toasts.
The Wails app uses
Windows or macOS system notifications when
desktop alerts are enabled. The app can optionally remain in the tray after its
window closes, using its existing notification socket and native toasts. Quit
from the tray menu exits the process. This does not make notifications work
after quitting the native app.
Room members can report another member's message; room owners can dismiss a
report or remove its message, with an audit record.

Independent reply threads and pinned messages are described in
[MESSAGE_THREADS.md](MESSAGE_THREADS.md). Edit revision archives remain
outside this delivery. These changes do not alter native media or clear the
desktop capture/auth acceptance gates.

## Local development

Use the repository's Docker PostgreSQL and opt-in loopback development login.
The Windows API launcher accepts the database's exposed port:

```powershell
docker compose up -d postgres
powershell -File scripts/start-api.ps1 -DevAuth -DatabasePort 54329
npm run dev -- --host 127.0.0.1
```

Use the actual local Docker port if it differs from 54329. Never put WorkOS
server credentials in frontend environment variables.

For a native notification check, enable **Desktop notifications** in Settings
on Windows or macOS. Enable **Keep running in the tray**, close the window,
then send a message from another account. The operating system should show a
notification; clicking it should restore BetterComms and open that conversation.
macOS must grant BetterComms notification permission. Repeat with a direct
call, and verify that disabling Desktop notifications stops both kinds of
system notice. This is a device acceptance check; the Windows build cannot
establish macOS behavior.

For browser notifications after closing the tab, run `go run ./cmd/vapid` in
`server/` and put its public/private pair plus a `mailto:` VAPID subject in
the server's private `.env`. Restart the API. Never put the private key in a
`VITE_` variable or Git. Browsers require a secure context; loopback HTTP is
accepted for development. The S3 credentials are still needed for attachment
previews.

Validation covers real PostgreSQL pagination, permissions, unread cursors,
search, edits/deletion, replies/reactions, plus two isolated browser users with
the real API. Browser checks do not establish physical native-media behavior.
