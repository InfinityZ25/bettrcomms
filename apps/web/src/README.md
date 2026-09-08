# Web source layout

The web client is organized by product feature. Keep files that change together
in the same feature directory, including component-specific styles, hooks, and
tests.

```text
src/
├── App.tsx            # Application composition and top-level routing state
├── main.tsx           # React entry point and global providers
├── api.ts             # Typed HTTP API boundary
├── styles.css         # Global tokens and application-wide styles
├── components/        # Reusable, feature-agnostic UI primitives
├── features/          # Product-facing React components grouped by domain
│   ├── call/
│   ├── friends/
│   ├── recordings/
│   ├── rooms/
│   ├── settings/
│   ├── sharing/
│   └── shell/
├── hooks/             # Reusable React hooks
├── lib/               # Small framework-independent helpers
└── media/             # Media engine, capture, transport, and persistence
```

## Conventions

- Use `@/…` for imports that cross directory boundaries.
- Use relative imports for files inside the same feature.
- Prefer Tailwind utilities in JSX for component and responsive styling.
- Keep CSS beside a feature only when it needs pseudo-elements, native browser
  controls, media-query coordination, or a stateful layout that utilities would
  make harder to understand.
- Keep tests beside the component or module they cover.
- Put a component in `components/` only when it is genuinely reusable across
  multiple features.
- Keep browser/native media lifecycle code in `media/`; React-facing orchestration
  belongs in the relevant feature.
- Avoid feature barrel files unless they provide a deliberate public API. Direct
  imports make dependencies and future moves easier to trace.
