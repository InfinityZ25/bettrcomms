# Messaging basics

Direct conversations and room chat share the same message controls. Open a
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

This increment does not introduce attachments, nested reply threads, edit
revision archives or send idempotency keys. It does not change native media or
clear the existing desktop capture/auth acceptance gates.

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

Validation covers real PostgreSQL pagination, permissions, unread cursors,
search, edits/deletion, replies/reactions, plus two isolated browser users with
the real API. Browser checks do not establish physical native-media behavior.
