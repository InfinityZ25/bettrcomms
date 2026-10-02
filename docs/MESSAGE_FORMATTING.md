# Message formatting

Messages and thread roots share a bounded Markdown renderer:
bold, italic, strikethrough, lists, quotes, inline/fenced code and `||spoilers||`.
Composer buttons wrap the current selection. Existing message bodies stay intact;
editing continues to expose the source text. HTML is escaped, external Markdown
images are never fetched, and links allow only HTTP(S) without embedded credentials.
Mentions resolve only outside code. Spoilers start concealed, including in search previews
and accessible markup, and can be revealed/hidden with the keyboard. Code blocks
scroll within their container and offer explicit copy with a visible fallback.

The renderer uses [react-markdown](https://github.com/remarkjs/react-markdown)
and remark-gfm without raw HTML plugins or remote rendering services. No syntax
highlighting worker, polling or additional socket is introduced.
