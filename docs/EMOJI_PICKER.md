# Emoji picker

Writing and reactions share a searchable, keyboard accessible picker with
3,944 fully qualified Unicode 17.0 emoji sequences, including skin tones,
flags and joined emoji. Search uses English Unicode names or the emoji itself.
Categories and pages keep the grid to 80 buttons. The catalog loads lazily only
when opened; plain messages do not load the Markdown renderer either.

Data comes from the pinned official [Unicode emoji list](https://unicode.org/Public/17.0.0/emoji/emoji-test.txt).
Run `node scripts/update-emoji-data.mjs` to regenerate both the frontend catalog
and server allowlist. The generator records the source checksum and includes
the Unicode license. Emoji use local system fonts, with no external image
requests. New Unicode glyphs depend on the operating system's font support.

The server accepts one qualified sequence per reaction and checks membership.
Each person may use ten reactions per message; each message may have twenty
different emoji. A locked message row enforces those limits during simultaneous
requests. Repeating a reaction is idempotent and removing one frees capacity.
