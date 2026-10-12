# Daily comfort

The personal inbox contains Saved and Reminders. The existing Activity center
continues to show mentions, replies and friendship requests. Personal data is
private to the signed-in account and does not change conversation membership.

Save a message from its actions, or save a single file from the message or file
library. The inbox filters All, Messages, Links and Files and opens the original
message or thread. Saves retain references, not copies or signed download URLs.
Edits appear in the inbox; deleted or currently inaccessible sources are hidden.
An access revocation retains the hidden reference so it can reappear if access
returns. Removing a save does not remove its source.

Message reminders offer one hour, tonight at 20:00, tomorrow at 09:00 and a custom
local date and time. The effective date is shown before saving. Opening or
answering the message leaves its reminder active. Use Snooze, Done or Cancel to
change it explicitly. Scheduled-event reminders remain available in the inbox.
The server materializes due reminders every ten seconds even without Web Push
credentials. Delivery rechecks source existence and current access.

Conversation actions offer one-hour, eight-hour, tomorrow-at-09:00 and custom
temporary mutes. The base All/Mentions/Mute preference remains intact and resumes
when the temporary deadline expires. Resume timed mute ends it early.

Settings → Notifications separates this device's Do not disturb and external
alerts from account quiet hours. Quiet hours specify starting weekdays, start,
end and a fixed IANA time zone. They start disabled; the form initializes from
the device's time zone. Overnight periods end the following day. Account DND,
quiet hours, device DND and conversation attention rules accumulate without
changing public availability or ending an existing call.

Personal reminders remain visible when due during quiet time. External attention
waits and resumes as one outstanding-reminders summary per registered device.
An explicit personal reminder ignores the conversation's ordinary mute. Device
leases and stable notification tags coordinate live and background delivery;
provider delivery is at least once, not a guarantee of exactly one OS alert.

Search supports local From/Through dates, Today, Yesterday, This week and links,
images, videos, audio or other files. Text is optional when a filter is present.
Dates become UTC intervals with an exclusive end. Author and conversation
filters, pagination and original-message/thread navigation remain available.
File matches require published, available attachments and do not duplicate a
message with several matching attachments.

Text drafts synchronize automatically by account, conversation and thread.
Local text is saved immediately; cloud writes debounce for 500 ms and use
versions and idempotent mutation IDs. Reply and mention context travel with the
text. Files, voice notes, upload references, editing an existing message and send
state stay on the device. Cloud state is read before importing an old local
draft. Different texts are preserved with Keep this device, Use other draft and
Copy other draft. An active editor is not silently replaced.

Sending clears only the submitted cloud revision in the message transaction.
Newer revisions survive; empty versioned records prevent a disconnected device
from restoring an old draft. Settings → Appearance → Sync text drafts controls
this feature independently of preference synchronization. Disabling it preserves
the local and cloud text and stops synchronization.

The HTTP contracts include `/me/saved-items`, `/me/message-reminders`, paginated
`/me/reminders`, `/me/notification-settings`, room notification preferences,
`/rooms/{room}/draft`, `/me/drafts` and `/me/draft-settings`. Context-menu aliases
remain compatible. Private WebSocket events invalidate caches without copying
personal content into event payloads. Account deletion clears all new private
rows and pending attention.
