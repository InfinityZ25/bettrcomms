# UI and accessibility review

Review date: 2026-09-05. Browser: Playwright Chromium. Live development app: `http://localhost:5173`. Viewports: 1440×900, 1280×720, and 390×844. Public and development-authenticated room states were captured under `tests/screenshots/a11y-*.png` and inspected visually.

## Automated results

After fixes, `npx playwright test tests/accessibility.spec.ts --reporter=line` was rerun on 2026-09-05 and passed all three tests in 7.5 seconds. Both public and signed Axe result maps were empty at all three viewports. The full six-test browser suite also passes. These automated checks remain a release gate and do not substitute for a complete manual accessibility audit.

The initial public and signed-room audits found the following contrast defects, all subsequently resolved by raising text foreground contrast:

| Viewports | Failing targets |
|---|---|
| 1440×900 and 1280×720 | `.section-label`, `.sidebar-note > p`, `.date-rule`, `.chat-caption` |
| 390×844 | `.date-rule`, `.chat-caption` |

Settings dialogs now restore focus to the opening control after Escape. The regression test verifies this explicitly.

Horizontal overflow assertions pass for all six public/signed viewport captures: the document scroll width does not exceed its client width.

## Visual findings

The 1440×900 public and signed layouts are balanced and readable, with clear grouping and no observed overlap. Long generated room names truncate rather than pushing header controls away. The stage, camera strip, call controls, and chat column retain their boundaries.

At 1280×720, the public sign-in area extends below the initial viewport. The call column now scrolls, the sign-in card cannot shrink, and the controls remain in normal keyboard order. The signed state fits more comfortably because it does not render the sign-in panel. Stage sizing was also changed to respect intrinsic child height rather than clip its bottom controls.

At 390×844, chat now starts closed so the stage and call controls are the default surface. Chat remains available as a dismissible drawer. Long room titles truncate cleanly and no document-level horizontal overflow was found. A stale mobile rule that hid the final call button was removed.

The regenerated screenshots show the corrected foreground colors. Camera-row height can now be changed with an accessible range control.

## Acceptance after fixes

Rerun the focused file and require all three tests to pass. Verify the 1280×720 public local-login controls can be reached using Tab and scrolling, and decide/test the intended mobile default panel. Inspect regenerated screenshots after any responsive CSS change because axe will not catch visual clipping or an undesirable initial panel choice.

The audit is best effort. Automated axe coverage cannot prove complete WCAG conformance; screen-reader announcements, zoom/reflow, touch target size, reduced motion, media captions, and real keyboard task completion still require manual review.
