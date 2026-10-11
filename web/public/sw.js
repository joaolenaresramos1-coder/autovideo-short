// Service worker: caches the app shell so the panel opens offline/fast.
// It never caches API or Supabase calls — automation runs on the server,
// not in this worker.
const CACHE = "autovideo-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("./index.html")));
    return;
  }
  // Static assets: cache first, then network (hashed file names change on deploy).
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ??
      fetch(e.request).then((res) => {
        if (res.ok && url.pathname.includes("/assets/")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }),
    ),
  );
});
