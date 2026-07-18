// Partial-Feature Completion Pass: the service worker half of Web Push Notifications -- receives
// the decrypted push event from the browser (decryption itself happens in the browser engine,
// using the subscription's own private key, before this handler ever runs) and shows a native OS
// notification. Deliberately minimal: this project has no offline-caching/PWA ambitions, so the
// only event this worker handles is 'push' (plus 'notificationclick' to focus the dashboard tab).
self.addEventListener('push', (event) => {
  let payload = { title: 'SentinelPay Alert', body: 'A critical fraud alert was triggered.' };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: undefined,
      tag: 'sentinelpay-critical-alert',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
