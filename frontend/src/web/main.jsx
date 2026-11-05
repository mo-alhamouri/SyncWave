import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import './web.css';
import WebApp from './WebApp.jsx';
import { installPlatform } from './platform.js';

// Cross-origin isolation lets the AI engine use several processor threads.
// GitHub Pages can't send the needed headers, so a tiny service worker adds
// them (coi-serviceworker.js); the page reloads once the first time.
async function isolate() {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    // Chrome and Firefox allow "credentialless" (keeps Google Fonts working); Safari needs require-corp.
    const coep = typeof window.chrome !== 'undefined' || /Firefox\//.test(navigator.userAgent) ? 'credentialless' : 'require-corp';
    const reg = await navigator.serviceWorker.register(`./coi-serviceworker.js?coep=${coep}`);
    let reloaded = false;
    try { reloaded = sessionStorage.getItem('sw-coi-reload') === '1'; } catch { /* storage blocked */ }
    if (!reloaded && (reg.active || reg.installing || reg.waiting)) {
      await navigator.serviceWorker.ready;
      if (!window.crossOriginIsolated) {
        try { sessionStorage.setItem('sw-coi-reload', '1'); } catch { return; } // no reload loop without storage
        window.location.reload();
      }
    }
  } catch { /* works without it, on one processor thread */ }
}

installPlatform();
isolate();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WebApp />
  </StrictMode>,
);
