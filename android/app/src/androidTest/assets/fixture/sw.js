// Minimal service worker that claims the page immediately and intercepts /probe.
// If the test sees "INTERCEPTED", fetch interception works in this WebView; the
// capability the real app's asset-decryption service worker depends on.
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (url.pathname === "/probe") {
    event.respondWith(
      new Response("INTERCEPTED", { headers: { "Content-Type": "text/plain" } })
    );
  }
});
