import { useState, useEffect, useRef } from 'react';
import StemSplitter from '../StemSplitter.jsx';
import WebTrimmer from './WebTrimmer.jsx';

// SyncWave on the web: the desktop app's Clip Trimmer and Vocal Remover,
// running in the browser. The YouTube Downloader needs the desktop app.

const HOME = '../';
const TABS = { downloader: 'downloader', trimmer: 'trimmer', 'vocal-remover': 'stems' };
const HASH = { downloader: 'downloader', trimmer: 'trimmer', stems: 'vocal-remover' };
const tabFromHash = () => TABS[window.location.hash.slice(1)] || 'stems';

const Icon = {
  downloader: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  trimmer: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12"/><path d="M18 9v12"/><path d="M2 12h20"/><path d="M6 12v6a2 2 0 0 0 2 2h12"/></svg>,
  stems: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>,
};

function DesktopOnly() {
  return (
    <div className="tab-container">
      <div className="header-section">
        <h1>YouTube <span className="gradient-text">Downloader</span></h1>
        <p>Download videos and music in studio quality.</p>
      </div>
      <div className="glass-panel main-panel web-desktop-only">
        <div className="upload-icon">💻</div>
        <h3>The YouTube Downloader is in the desktop app</h3>
        <p>Browsers can't download from YouTube, so this tool needs the free SyncWave app for Mac and Windows. It also runs the Vocal Remover faster on your computer.</p>
        <ul>
          <li>MP3 320 kbps or MP4 up to 1080p</li>
          <li>Trim before you download</li>
          <li>Clip Trimmer and Vocal Remover included</li>
        </ul>
        <a className="export-trigger-btn-stylish web-cta" href={HOME}>Download SyncWave (free)</a>
      </div>
    </div>
  );
}

export default function WebApp() {
  const [activeTab, setActiveTab] = useState(tabFromHash);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const stemsRef = useRef(null);
  const trimRef = useRef(null);

  const showToast = (message, type = 'error') => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => {
    const onHash = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTab = (tab) => {
    if (tab !== 'stems' && stemsRef.current) stemsRef.current.pause();
    if (tab !== 'trimmer' && trimRef.current) trimRef.current.pause();
    setActiveTab(tab);
    window.history.replaceState(null, '', `#${HASH[tab]}`);
  };

  const nav = (tab, label, extra) => (
    <button className={`nav-item ${activeTab === tab ? 'active' : ''}`} onClick={() => switchTab(tab)}>
      {Icon[tab]}
      <span>{label}</span>
      {extra}
    </button>
  );

  return (
    <div className="app-shell web-shell">
      {toast && (
        <div className={`toast-notification ${toast.type}`} role="status">
          <div className="toast-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>{toast.message}</span>
          </div>
          <button onClick={() => setToast(null)} className="toast-close" aria-label="Close">&times;</button>
        </div>
      )}
      <aside className="sidebar">
        <a className="sidebar-logo web-logo" href={HOME}><span>SyncWave</span></a>
        <nav className="sidebar-nav">
          {nav('downloader', 'Downloader', <span className="web-app-badge">App</span>)}
          {nav('trimmer', 'Clip Trimmer')}
          {nav('stems', 'Vocal Remover')}
        </nav>
        <div className="web-sidebar-footer">
          <p>Runs in your browser. Your files are never uploaded.</p>
          <a className="btn-secondary-stylish web-get-app" href={HOME}>Get the desktop app</a>
        </div>
      </aside>

      <main className="main-content">
        {activeTab === 'downloader' && <DesktopOnly />}
        <div style={{ display: activeTab === 'trimmer' ? 'block' : 'none' }}>
          <WebTrimmer ref={trimRef} active={activeTab === 'trimmer'} showToast={showToast} />
        </div>
        {/* Kept mounted so separated stems survive switching tabs */}
        <div style={{ display: activeTab === 'stems' ? 'block' : 'none' }}>
          <StemSplitter ref={stemsRef} active={activeTab === 'stems'} showToast={showToast} />
        </div>
      </main>
    </div>
  );
}
