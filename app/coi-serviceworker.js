// SyncWave web app: adds the two headers browsers need for "cross-origin
// isolation" (lets the AI engine use several processor threads). GitHub Pages
// can't send custom headers, so this service worker adds them to the pages
// and files it serves. Registered by the web app (src/web/main.jsx).
const coep = new URL(self.location.href).searchParams.get('coep') === 'credentialless' ? 'credentialless' : 'require-corp';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    event.respondWith((async () => {
        const res = await fetch(req);
        if (res.status === 0) return res; // opaque responses can't be changed
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Embedder-Policy', coep);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        if (!headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })());
});
