/** Closing overlays remain mounted briefly for their exit transition. */
export function hasBlockingOverlay() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    ),
  ].some(
    (element) =>
      !element.hasAttribute('data-closed') &&
      !element.hasAttribute('data-ending-style') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0,
  );
}
