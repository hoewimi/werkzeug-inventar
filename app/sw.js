// Service Worker der App (E26): Cache-first für die eigenen Dateien, damit die Home-Bildschirm-App offline startet.
// Den Cache-Namen bei jeder Änderung an src/ erhöhen (und VERSION in app.js mit); dann lädt das iPhone alles neu.
// Fremde Adressen (api.anthropic.com) werden nie angefasst oder gecacht.
const CACHE = "werkzeug-inventar-v1";
const DATEIEN = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./ablage.js",
  "./bild.js",
  "./csv.js",
  "./daten.js",
  "./sicherung.js",
  "./typenschild.js",
  "./zip.js",
  "./vendor/jsQR.js",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(DATEIEN.map((d) => new Request(d, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  // Nur eigene alte Caches löschen; der Ursprung hoewimi.github.io wird mit anderen Seiten geteilt.
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n.startsWith("werkzeug-inventar-") && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
