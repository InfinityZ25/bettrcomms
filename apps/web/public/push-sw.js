self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { return; }
    if (payload.kind === 'reminder-summary') {
      if (typeof payload.tag !== 'string' || !payload.tag.startsWith('bettercomms-reminders:')) return;
      await self.registration.showNotification('BetterComms reminders', { body: 'You have reminders to review.', tag: payload.tag, data: { personalInbox: 'reminders' } });
      return;
    }
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
    const personalInbox = event.notification.data?.personalInbox;
    const url = new URL('/', self.location.origin);
    if (typeof roomId === 'string') url.searchParams.set('open_room', roomId);
    if (personalInbox === 'reminders') url.searchParams.set('open_inbox', 'reminders');
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients[0];
    if (existing) {
      try {
        existing.postMessage({ type: 'bc-notification-click', roomId, personalInbox });
        await existing.focus();
        return;
      } catch { /* Open a new window if this client cannot navigate. */ }
    }
    await self.clients.openWindow(url.href);
  })());
});
