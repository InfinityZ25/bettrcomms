# Message pins and threads

Open **Conversation threads** above a conversation to browse its threads,
including threads whose original message is outside loaded history. Threads
show reply counts and unread counts. **Open thread** on a message starts an
independent discussion; ordinary **Reply** still sends a quote in the current
conversation. Desktop shows the thread beside the main history. On phones,
the thread replaces that view until **Close thread** is pressed.

Each thread has its own history pagination, draft, typing indicator and read
cursor. Opening or marking the main history read does not acknowledge unseen
thread replies. Conversation badges include unread replies; opening the
corresponding thread acknowledges visible replies under the same focus and
scroll conditions as the main history. Search includes replies and opens their
thread, with the matching message highlighted. Quotes cannot cross thread
boundaries; replies in a thread may quote its original message.

Deleting the original message leaves a tombstone and preserves its existing
thread. A deleted message without an existing thread cannot start one. Replies
retain the same edit, delete, reaction, attachment and moderation controls as
ordinary messages. A thread cannot recursively create another thread.

Choose **Pin message** to retain an important message. Channel owners may pin
or unpin; either participant may do so in a direct conversation. The server
limits a conversation to fifty pins. **Pinned messages** lists them newest
first and jumps to the original history or thread. Deleting or moderating a
pinned message removes its pin. Pinning does not send a new chat message.

The implementation extends the existing authenticated event stream. It adds
no background polling or per-thread socket. Caches retain at most twelve
inactive histories across room and thread scopes; closing or changing accounts
releases requests, observers and typing timers. PostgreSQL membership checks
and transactional writes apply equally to threads, pins and attachments.

API additions:

- `GET /rooms/{room}/pins` returns `{messages: Message[]}`.
- `PUT /rooms/{room}/messages/{message}/pin` pins a live message; `DELETE`
  unpins it. Both return `{message}` with versioned pin metadata.
- `GET /rooms/{room}/threads?before_id={root}&limit=50` returns roots ordered
  by latest reply, with reply and unread counts.
- `GET /rooms/{room}/threads/{root}/messages` returns `{messages, root,
  before_id?, read_sequence}`. `before_id` and `after_sequence` use the same
  pagination conventions as the main history and cannot be combined.
- `POST /rooms/{room}/messages` accepts optional `thread_root_id` alongside
  the existing body, quote, attachment and idempotency fields. Root and quoted
  message must belong to the same room and scope.
- `PUT /rooms/{room}/threads/{root}/read` accepts `{message_id}` and advances
  only that thread's read cursor.
- `chat.typing` optionally carries `thread_root_id`. `chat.message` and
  `chat.updated` carry the message's scope; root updates refresh reply counts.

Migration `010_conversation_threads_pins.sql` is additive. It preserves
existing messages, quote replies and room read cursors. New members start at
the committed end of existing threads. Browser tests exercise the real API and
local PostgreSQL; desktop platform acceptance still requires the real Wails
build on each target OS.
