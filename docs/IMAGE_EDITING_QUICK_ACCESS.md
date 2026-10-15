# Image editing and quick access

## Image editing before sending

Add an image with the file chooser, clipboard or drop area, then choose **Edit
image** on its pending attachment. Crop accepts a pointer/touch rectangle or
numeric Left, Top, Width and Height values. Rotate turns the image clockwise in
90-degree steps. Draw and Arrow add marks; Redact covers a rectangle with opaque
black pixels. Undo, Redo and Reset image operate inside the editor.

**Use edited image** produces a new `<name>-edited.png` file on this device and
replaces only that pending attachment. This is a flattened raster: annotations
and redactions are pixels, and source metadata is not copied into the export.
The resulting PNG is previewed before the ordinary **Send message** action.
Cancel, closing the editor, or an export error keeps the prior pending file.
Opening or applying the editor never sends a message or starts an upload.

The same attachment flow is used in main messages and thread replies. Replacing
a previously uploaded pending attachment clears its server/resume reference and
requests cleanup through the existing private attachment boundary. Device-local
draft recovery stores the replacement file, not an editing project with hidden
source layers. Account/conversation changes and lost publication permission
discard the editor's temporary resources and reject a late export.

Supported inputs are static PNG, JPEG and WebP, subject to a 25 MiB input limit,
12 million decoded pixels and an 8192-pixel maximum side. GIF, SVG, animated PNG
and animated WebP are not silently converted. An explanatory error leaves the
original available as an ordinary attachment. These editor limits do not reduce
the ordinary 500 MiB attachment limit.

Canvas export is local to the browser or shared Wails frontend. This feature
does not require an external image service, change media capture, or establish
packaged native acceptance.

## Quick access

Use **Quick access** in navigation, **Ctrl+K** on Windows/Linux, or **Command+K**
on macOS. Type a friend, conversation, channel or setting name. Results include
context to distinguish similarly named channels. Accent-insensitive matching,
grouped results, favorites and recent conversation activity keep common
destinations within reach.

Use arrow keys and Enter to choose, or Escape to return to the prior control.
The shortcut works from the message composer without replacing its draft and
does not take over an already open modal such as the image editor or Settings.
Touch users have the same visible trigger. Message content search remains
available from its existing buttons and **Ctrl/Command+Shift+F**.

Selecting an existing conversation changes the view without joining/leaving a
call or sending a message. Choosing a friend uses the existing explicit direct
conversation action. Channel results come from the account's authorized room
list; membership changes and logout remove inaccessible results. Settings use
the same existing account/settings controls and permissions.

## Validation

Focused unit tests cover image headers, bounds and edit geometry, and Quick
access matching/ranking. Browser acceptance uses the real local API,
PostgreSQL and disposable S3-compatible storage. It checks that editing stays
local, actual uploaded PNG dimensions and redacted pixels, metadata removal,
cancel, threads, phone layout, keyboard/focus behavior, navigation and call
continuity. These checks do not replace native packaged or production account
acceptance.
