import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('latency follows the current socket and rejects invalid measurements', async ({ page }) => {
  await mount(page, { joined: true, peerCount: 0, rttMs: 27, stats: [], names: {} });
  const trigger = page.getByRole('button', { name: 'Connection diagnostics' });
  await expect(trigger).toHaveAttribute('title', 'Server ping: 27 ms');
  await page.evaluate(() => {
    const replacement = new EventTarget();
    (window as any).__replacementSignaling = replacement;
    (window as any).__renderConnection({ joined: true, peerCount: 0, stats: [], names: {}, signaling: replacement });
  });
  await expect(trigger).toHaveAttribute('title', 'Server ping: —');
  await page.evaluate(() => {
    (window as any).__signaling.dispatchEvent(new CustomEvent('latency', { detail: { rttMs: 99 } }));
  });
  await expect(trigger).toHaveAttribute('title', 'Server ping: —');
  for (const value of [0, -1, 18, Infinity, 12, NaN, 7, null]) {
    await page.evaluate(rttMs => {
      (window as any).__replacementSignaling.dispatchEvent(new CustomEvent('latency', { detail: { rttMs } }));
    }, value);
    const expected = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value} ms` : '—';
    await expect(trigger).toHaveAttribute('title', `Server ping: ${expected}`);
  }
});

// ConnectionStatus reads server RTT off a real signaling EventTarget's
// 'latency' events rather than taking it as a plain prop (a state update on
// every 5s ping otherwise re-rendered all of CallStage's inline, unmemoized
// camera tiles just to update this panel's number). These fixtures stand
// in a plain EventTarget for `signaling` and dispatch 'latency' themselves.
async function mount(
  page: Page,
  props: Record<string, unknown> & { rttMs?: number | null },
) {
  await page.goto(baseURL);
  await page.evaluate(async ({ rttMs, ...initialProps }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import(
      '/node_modules/.vite/deps/react-dom_client.js'
    )).default;
    const ConnectionStatus = (
      await import('/src/features/call/ConnectionStatus.tsx')
    ).default;
    document.body.innerHTML = '<div id="connection-fixture"></div>';
    const root = ReactDOM.createRoot(
      document.getElementById('connection-fixture')!,
    );
    const signaling = new EventTarget();
    let subscribed!: () => void;
    const ready = new Promise<void>(resolve => { subscribed = resolve; });
    const addListener = signaling.addEventListener.bind(signaling);
    signaling.addEventListener = (type, listener, options) => {
      addListener(type, listener, options);
      if (type === 'latency') subscribed();
    };
    (window as any).__signaling = signaling;
    (window as any).__renderConnection = (next: Record<string, unknown>) =>
      root.render(
        React.createElement(ConnectionStatus, {
          signaling,
          ...next,
          onDetails: () => {
            document.body.dataset.details = 'opened';
          },
        }),
      );
    (window as any).__renderConnection(initialProps);
    await ready;
    if (rttMs !== undefined) {
      // Await the actual subscription, not text that the icon-only button
      // no longer renders. A single event must be sufficient.
      signaling.dispatchEvent(new CustomEvent('latency', { detail: { rttMs } }));
    }
  }, props);
}

test('server voice is visible and does not present signaling ping as peer latency', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await mount(page, {
    joined: true, peerCount: 1, rttMs: 31, names: { friend: 'Sam' },
    stats: [{ peerId: 'friend', timestamp: 1, connectionState: 'failed', tracks: [],
      voiceRelay: { state: 'relayed', verificationCode: '1111-2222-3333-4444-5555-6666-7777-8888' } }],
  });
  const trigger = page.getByRole('button', { name: 'Connection diagnostics' });
  await expect(trigger).toHaveAccessibleDescription('Voice via server');
  await expect(trigger).toHaveAttribute('title', 'Server ping: 31 ms');
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Connection details' });
  await expect(panel).toContainText('Encrypted server voice · TCP');
  await expect(panel).toContainText('not the full relayed audio path');
  await page.getByText('Verify voice with Sam', { exact: true }).click();
  await expect(panel.locator('code')).toContainText('1111-2222');
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '.local/voice-relay-connection.png' });
});

test('server-only status reports signaling latency and closes with Escape', async ({
  page,
}) => {
  await mount(page, {
    joined: true,
    peerCount: 0,
    rttMs: 42.4,
    stats: [],
    names: {},
  });
  const trigger = page.getByRole('button', { name: 'Connection diagnostics' });
  await expect(trigger).toHaveAccessibleDescription('Waiting for company');
  await expect(trigger).toHaveAttribute('title', 'Server ping: 42 ms');
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Connection details' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('server ping');
  await expect(panel).toContainText('42 ms');
  await expect(panel).toContainText('Call ping appears when a friend connects.');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('call status preserves zero and unknown RTT, routes, and responsive bounds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await mount(page, {
    joined: true,
    peerCount: 2,
    rttMs: 18,
    names: { direct: 'Alex', relay: 'A very long participant name for layout' },
    stats: [
      {
        peerId: 'direct',
        timestamp: 1,
        connectionState: 'connected',
        route: {
          localCandidateType: 'host',
          remoteCandidateType: 'srflx',
          currentRoundTripTimeMs: 0,
        },
        tracks: [],
      },
      {
        peerId: 'relay',
        timestamp: 1,
        connectionState: 'connected',
        route: { localCandidateType: 'relay' },
        tracks: [],
      },
    ],
  });
  const trigger = page.getByRole('button', { name: 'Connection diagnostics' });
  await expect(trigger).toHaveAttribute('title', 'Call ping: 0 ms');
  await trigger.click();
  const panel = page.getByRole('region', { name: 'Connection details' });
  await expect(panel.locator('header')).toContainText('Through a relay');
  await expect(panel).toContainText('Alex');
  await expect(panel).toContainText('Direct');
  await expect(panel).toContainText('A very long participant name for layout');
  await expect(panel).toContainText('Relay');
  const peers = panel.locator('.connection-peer');
  await expect(peers.nth(0).locator('strong')).toHaveText('0 ms');
  await expect(peers.nth(1).locator('strong')).toHaveText('—');
  const bounds = await panel.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(320);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(480);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  await page.screenshot({ path: '.local/connection-status-mobile.png' });
  await page.getByRole('button', { name: 'Close connection details' }).click();
  await expect(panel).toHaveCount(0);
});
