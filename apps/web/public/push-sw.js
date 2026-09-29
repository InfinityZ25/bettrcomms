self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // An open page already handles its own alerts and room preferences.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length) return;
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { return; }
    if (typeof payload.room_id !== 'string') return;
    await self.registration.showNotification(typeof payload.title === 'string' ? payload.title : 'BetterComms', {
      body: 'New message in BetterComms',
      tag: `message:${payload.room_id}`,
      data: { roomId: payload.room_id },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const roomId = event.notification.data?.roomId;
    const url = new URL('/', self.location.origin);
    if (typeof roomId === 'string') url.searchParams.set('open_room', roomId);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients[0];
    if (existing) {
      try {
        const opened = await existing.navigate(url.href);
        if (opened) { await opened.focus(); return; }
      } catch { /* Open a new window if this client cannot navigate. */ }
    }
    await self.clients.openWindow(url.href);
  })());
});
