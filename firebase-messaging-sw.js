// Service worker des notifications (Firebase Cloud Messaging). Les messages arrivent en « data »
// et sont affichés ici, pour un comportement identique sur tous les navigateurs.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyCUZc33r0RzJA0S0v64DApDgTacE7O7Khg",
  authDomain: "replays-cs2.firebaseapp.com",
  projectId: "replays-cs2",
  storageBucket: "replays-cs2.firebasestorage.app",
  messagingSenderId: "1026475466360",
  appId: "1:1026475466360:web:3369ffd372ffd561b0578d"
});
const messaging = firebase.messaging();
messaging.onBackgroundMessage((p) => {
  const d = p.data || {};
  return self.registration.showNotification(d.title || "Replays Vitality", {
    body: d.body || "", icon: "icons/icon-192.png", tag: d.tag || undefined, data: { link: d.link || self.registration.scope }
  });
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if (w.url.startsWith(self.registration.scope) && "navigate" in w) { await w.focus(); return w.navigate(link); }
    return clients.openWindow(link);
  })());
});
