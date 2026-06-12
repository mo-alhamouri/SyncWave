import React, { useState, useEffect, useRef } from 'react';
import TransferTab from './TransferTab';

// Helper to format duration in seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const sStr = s < 10 ? `0${s}` : s;
  
  if (h > 0) {
    const mStr = m < 10 ? `0${m}` : m;
    return `${h}:${mStr}:${sStr}`;
  }
  return `${m}:${sStr}`;
}

// Helper to format view count (e.g. 1.2M, 450K)
function formatViews(views) {
  if (!views) return '0';
  if (views >= 1e9) return (views / 1e9).toFixed(1) + 'B';
  if (views >= 1e6) return (views / 1e6).toFixed(1) + 'M';
  if (views >= 1e3) return (views / 1e3).toFixed(0) + 'K';
  return views.toLocaleString();
}

function App() {
  const [activeTab, setActiveTab] = useState('downloader');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [error, setError] = useState('');
  const [format, setFormat] = useState('mp3-320');
  const [version, setVersion] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  
  // Trimmer Specific State
  const [localFile, setLocalFile] = useState(null);
  const [localDuration, setLocalDuration] = useState(0);
  const [trimming, setTrimmerLoading] = useState(false);
  const [trimSuccess, setTrimSuccess] = useState(false);

  // Refs
  const activeEventSource = useRef(null);
  const playerRef = useRef(null);
  const localPlayerRef = useRef(null);
  const hiddenAudioRef = useRef(null);
  const inputRef = useRef(null);
  const spectrumRef = useRef(null);
  
  // Trimming State
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [waveform, setWaveform] = useState([]);
  
  const [downloadState, setDownloadState] = useState('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadMsg, setDownloadMsg] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [toast, setToast] = useState(null);

  // Playlist states
  const [selectedItemIds, setSelectedItemIds] = useState({});
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueActive, setQueueActive] = useState(false);

  // Toast Helper - NO AUTO-HIDE FOR ERRORS
  const showToast = (message, type = 'error') => {
    setToast({ message, type });
    if (type === 'success') {
      setTimeout(() => setToast(null), 5000);
    }
  };

  const filteredPlaylistEntries = metadata?.isPlaylist 
    ? metadata.entries.filter(item => item.title.toLowerCase().includes(playlistSearch.toLowerCase()))
    : [];

  // Auto-focus, Badge Clearing, and Version Check
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
    
    if (window.electron) {
      window.electron.getVersion().then(setVersion);

      const removeAvailableListener = window.electron.onUpdateAvailable((info) => {
        setUpdateAvailable(info.version);
      });
      const removeDownloadedListener = window.electron.onUpdateDownloaded(() => {
        setUpdateDownloaded(true);
      });

      const handleFocus = () => {
        if (window.electron && window.electron.clearBadge) {
          window.electron.clearBadge();
        }
      };
      
      window.addEventListener('focus', handleFocus);

      return () => {
        removeAvailableListener();
        removeDownloadedListener();
        window.removeEventListener('focus', handleFocus);
      };
    }
  }, []);

  // RESET UI IF FORMAT CHANGES
  useEffect(() => {
    if (downloadState === 'completed' || downloadState === 'error') {
      setDownloadState('idle');
      setDownloadMsg('');
      setDownloadPercent(0);
    }
  }, [format]);

  // Handle Dragging Logic
  useEffect(() => {
    if (!dragging) return;

    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      if (!spectrumRef.current) return;
      const rect = spectrumRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const duration = activeTab === 'downloader' ? metadata?.duration : localDuration;
      const time = (x / rect.width) * (duration || 1);

      if (dragging === 'start') {
        const nextStart = Math.min(time, endTime - 0.1);
        setStartTime(nextStart);
        handleSeek(nextStart);
      } else {
        const nextEnd = Math.max(time, startTime + 0.1);
        setEndTime(nextEnd);
        handleSeek(nextEnd);
      }
    };

    const onMouseUp = () => {
      setDragging(null);
      document.body.style.userSelect = originalUserSelect;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = originalUserSelect;
    };
  }, [dragging, startTime, endTime, metadata?.duration, localDuration, activeTab]);

  const handleSelectLocalFile = async () => {
    if (window.electron) {
      const file = await window.electron.selectFile();
      if (file) {
        setLocalFile(file);
        setTrimSuccess(false);
        setStartTime(0);
        setEndTime(0);
        setLocalDuration(0);
        setWaveform([]);
      }
    }
  };

  const handleLocalTrim = async () => {
    if (!localFile || trimming) return;
    setTrimmerLoading(true);
    
    try {
      const ext = localFile.name.split('.').pop().toLowerCase();
      const result = await window.electron.trimLocalFile(localFile.path, ext, startTime, endTime);
      if (result.success) {
        setTrimSuccess(true);
        showToast('Clip exported successfully!', 'success');
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      showToast(err.message || 'Trimming failed');
    } finally {
      setTrimmerLoading(false);
    }
  };

  const handleSeek = (time) => {
    if (activeTab === 'downloader' && playerRef.current) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }),
        '*'
      );
    } else if (activeTab === 'trimmer') {
       const player = localFile?.name.match(/\.(mp3|wav|ogg|flac|m4a)$/i) ? hiddenAudioRef.current : localPlayerRef.current;
       if (player) player.currentTime = time;
    }
  };

  const togglePlay = () => {
    if (activeTab === 'downloader' && playerRef.current) {
      const command = isPlaying ? 'pauseVideo' : 'playVideo';
      if (!isPlaying) handleSeek(startTime);
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: command, args: [] }),
        '*'
      );
      setIsPlaying(!isPlaying);
    } else if (activeTab === 'trimmer') {
      const currentPlayer = localFile?.name.match(/\.(mp3|wav|ogg|flac|m4a)$/i) ? hiddenAudioRef.current : localPlayerRef.current;
      
      if (!currentPlayer) return;

      if (isPlaying) {
        currentPlayer.pause();
        setIsPlaying(false);
      } else {
        currentPlayer.currentTime = startTime;
        currentPlayer.play().catch(e => console.error('Play failed:', e));
        setIsPlaying(true);
        
        const checkTime = () => {
          if (currentPlayer && !currentPlayer.paused) {
             if (currentPlayer.currentTime >= endTime) {
                currentPlayer.pause();
                currentPlayer.currentTime = startTime;
                setIsPlaying(false);
             } else {
                requestAnimationFrame(checkTime);
             }
          } else {
             setIsPlaying(false);
          }
        };
        requestAnimationFrame(checkTime);
      }
    }
  };

  const handleInstallUpdate = () => {
    if (window.electron) window.electron.quitAndInstall();
  };

  const toggleMaximize = async () => {
    if (window.electron) {
        if (await window.electron.isMaximized()) {
            window.electron.unmaximize();
            setIsMaximized(false);
        } else {
            window.electron.maximize();
            setIsMaximized(true);
        }
    }
  };

  const handleAnalyze = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setMetadata(null);
    
    // Reset download state to idle so analyze doesn't look like a download
    setDownloadState('idle'); 

    try {
      if (window.electron && window.electron.getInfo) {
        const data = await window.electron.getInfo(url.trim());
        if (data.error) throw new Error(data.error);
        
        if (data.isPlaylist) {
          const selection = {};
          data.entries.forEach(item => selection[item.id] = true);
          setSelectedItemIds(selection);
        }

        setMetadata(data);
        setStartTime(0);
        setEndTime(data.duration || 0);
        setDownloadState('idle');
        setDownloadPercent(0);
      }
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Error occurred while loading details.');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!metadata || downloadState !== 'idle') return;

    setDownloadState('started');
    setDownloadPercent(5);
    setDownloadMsg('Initializing Engine...');
    
    if (window.electron && window.electron.download) {
      window.electron.download(url.trim(), format);
      
      const removeProgressListener = window.electron.onDownloadProgress((data) => {
        if (data.status === 'processing') {
          setDownloadState('processing');
          setDownloadPercent(95);
          setDownloadMsg('Finalizing & Encoding High-Quality File...');
        } else {
          setDownloadState('downloading');
          const progress = Math.max(10, Math.floor(data.percent || 0));
          setDownloadPercent(progress);
          setDownloadMsg('Downloading Streams...');
        }
      });

      const removeCompletedListener = window.electron.onDownloadCompleted(() => {
        cleanup();
        setDownloadState('completed');
        setDownloadMsg('Download Complete! Saved to your Downloads folder');
        setDownloadPercent(100);
      });

      const removeErrorListener = window.electron.onDownloadError((data) => {
        cleanup();
        setDownloadState('error'); // Error state keeps buttons visible but in "Retry" mode conceptually
        showToast(data.error || 'Download failed.');
        setDownloadMsg('Download Failed. Check logs or try again.');
      });

      const cleanup = () => {
        removeProgressListener();
        removeCompletedListener();
        removeErrorListener();
      };

      activeEventSource.current = { close: () => window.electron.stopDownload() };
    }
  };

  const handleStopQueue = () => {
    if (activeEventSource.current && activeEventSource.current.close) {
      activeEventSource.current.close();
    }
    activeEventSource.current = 'stopped';
    setQueueActive(false);
    setDownloadState('idle');
    setLoading(false);
    setDownloadPercent(0);
    setDownloadMsg('Process stopped by user.');
  };

  const checkUpdates = async () => {
    if (window.electron) {
      const update = await window.electron.checkUpdates();
      if (update && update.version !== `v${version}`) {
        alert(`New version ${update.version} available! Download it at: ${update.url}`);
      } else {
        alert('You are on the latest version.');
      }
    }
  };

  const isDownloading = downloadState !== 'idle' && downloadState !== 'completed' && downloadState !== 'error';

  return (
    <div className="app-shell">
      {toast && (
        <div className={`toast-notification ${toast.type}`}>
          <div className="toast-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>{toast.message}</span>
          </div>
          <button onClick={() => setToast(null)} className="toast-close">&times;</button>
        </div>
      )}
      <div className="sidebar">
        <div className="sidebar-drag-area"></div>
        <div className="sidebar-logo">
          <div className="logo-icon">🌊</div>
          <span>SyncWave</span>
        </div>
        
        <div className="window-controls-container">
           <button onClick={() => window.electron.minimize()} className="win-btn minimize" title="Minimize">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>
           </button>
           <button onClick={toggleMaximize} className="win-btn maximize" title={isMaximized ? "Restore" : "Maximize"}>
              {isMaximized ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="4" y1="9" x2="20" y2="9"/></svg>
              ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              )}
           </button>
        </div>

        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === 'downloader' ? 'active' : ''}`}
            onClick={() => setActiveTab('downloader')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Downloader
          </button>
          <button 
            className={`nav-item ${activeTab === 'trimmer' ? 'active' : ''}`}
            onClick={() => setActiveTab('trimmer')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12"/><path d="M18 9v12"/><path d="M2 12h20"/><path d="M6 12v6a2 2 0 0 0 2 2h12"/></svg>
            Clip Trimmer
          </button>
          <button 
            className={`nav-item ${activeTab === 'transfer' ? 'active' : ''}`}
            onClick={() => setActiveTab('transfer')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/><rect x="2" y1="17" width="20" height="4" rx="2"/></svg>
            Mobile Transfer
          </button>
        </nav>

        <div className="sidebar-footer">
          {updateAvailable && (
            <div className="update-banner">
              <div className="update-info">
                <span>Update v{updateAvailable}</span>
                <p>{updateDownloaded ? 'Ready to install' : 'Downloading...'}</p>
              </div>
              {updateDownloaded && (
                <button onClick={handleInstallUpdate} className="install-update-btn">Restart & Update</button>
              )}
            </div>
          )}
          <span>v{version}</span>
          <button onClick={checkUpdates}>Update</button>
        </div>
      </div>

      <div className="main-content">
        {activeTab === 'downloader' && (
          <div className="tab-container">
            <div className="header-section">
              <h1>YouTube <span className="gradient-text">Downloader</span></h1>
              <p>Download your favorite content in studio quality.</p>
            </div>

            <div className="glass-panel main-panel">
              <form onSubmit={handleAnalyze} className="url-form">
                <div className="input-group">
                  <input
                    ref={inputRef}
                    type="text"
                    placeholder="Paste link here..."
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="url-input"
                    disabled={isDownloading}
                  />
                  <button type="submit" className="analyze-btn" disabled={loading || isDownloading}>
                    {loading ? <div className="spinner-small"></div> : 'Analyze'}
                  </button>
                </div>
              </form>

              {metadata && (
                <div className="settings-section">
                  {metadata.isPlaylist ? (
                    <div className="playlist-layout">
                      <div className="playlist-info-panel">
                        <div className="playlist-meta-info">
                          <span className="playlist-meta-title">{metadata.title}</span>
                          <div className="playlist-meta-channel">{metadata.channel}</div>
                        </div>
                      </div>
                      <div className="playlist-list-container">
                        <div className="playlist-scroll-list">
                          {filteredPlaylistEntries.map(item => (
                            <div key={item.id} className="playlist-row-item">
                              <span className="playlist-row-title">{item.title}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="preview-card-simple">
                      <div className="static-thumbnail">
                        <img src={metadata.thumbnail} alt="" />
                        <div className="duration-pill">{formatDuration(metadata.duration)}</div>
                      </div>
                      <div className="video-info-content">
                        <h3 className="video-title">{metadata.title}</h3>
                        <div className="video-channel">{metadata.channel}</div>
                        <div className="video-meta-row">
                          <span>{formatViews(metadata.viewCount)} views</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="download-actions-row">
                    <div className="format-picker-elegant">
                      <span>Format:</span>
                      <select value={format} onChange={(e) => setFormat(e.target.value)} className="quality-select-inline" disabled={isDownloading}>
                        <option value="mp3-320">MP3 320kbps</option>
                        <option value="4k">MP4 4K</option>
                        <option value="1080p">MP4 1080p</option>
                        <option value="720p">MP4 720p</option>
                      </select>
                    </div>
                    <div className="download-primary-actions">
                      {(downloadState === 'idle' || downloadState === 'completed' || downloadState === 'error') && (
                        <button onClick={handleDownload} className="export-trigger-btn-stylish">Start Pro Download</button>
                      )}
                      {isDownloading && (
                        <button onClick={handleStopQueue} className="stop-button-stylish">Stop Process</button>
                      )}
                    </div>
                  </div>

                  {isDownloading && (
                    <div className="progress-panel">
                      <div className="progress-header">
                        <span>{downloadMsg}</span>
                        <span className="progress-pct">{downloadPercent}%</span>
                      </div>
                      <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${downloadPercent}%` }}></div></div>
                    </div>
                  )}
                  
                  {downloadState === 'completed' && (
                    <div className="success-banner padded">✨ Download Complete! Saved to your folder.</div>
                  )}
                  {downloadState === 'error' && (
                    <div className="error-banner padded">⚠️ Download encountered an error. See toast for details.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'trimmer' && (
          <div className="tab-container">
            <div className="header-section">
              <h1>Clip <span className="gradient-text">Trimmer</span></h1>
              <p>Precision cut any local audio or video file.</p>
            </div>

            <div className="glass-panel main-panel">
              {!localFile ? (
                <div className="upload-zone" onClick={handleSelectLocalFile}>
                  <div className="upload-icon">📁</div>
                  <h3>Select a file to trim</h3>
                  <p>Supports MP4, MP3, MOV, WAV and more</p>
                </div>
              ) : (
                <div className="trimmer-workspace">
                  <div className="trimmer-media-preview">
                    {localFile.name.match(/\.(mp3|wav|ogg|flac|m4a)$/i) ? (
                      <div className="audio-placeholder-pro">
                        <audio 
                          ref={hiddenAudioRef}
                          src={`media://${localFile.path}`}
                          onLoadedMetadata={(e) => {
                            const duration = e.target.duration;
                            setLocalDuration(duration);
                            setStartTime(0);
                            setEndTime(duration);
                          }}
                        />
                        <div className="audio-viz-bars">
                          {[...Array(12)].map((_, i) => <div key={i} className="viz-bar"></div>)}
                        </div>
                      </div>
                    ) : (
                      <video 
                        ref={localPlayerRef}
                        src={`media://${localFile.path}`}
                        onLoadedMetadata={(e) => {
                          const duration = e.target.duration;
                          setLocalDuration(duration);
                          setStartTime(0);
                          setEndTime(duration);
                        }}
                        className="local-preview-player"
                        controls
                      />
                    )}
                  </div>

                  <div className="trimmer-info">
                    <h3 className="video-title">{localFile.name}</h3>
                    <div className="trim-actions-row">
                      <div className="trim-primary-actions-full">
                        <button onClick={() => { setLocalFile(null); setEndTime(0); setStartTime(0); }} className="btn-secondary-stylish">Change File</button>
                        <button 
                          onClick={handleLocalTrim} 
                          className="export-trigger-btn-stylish" 
                          disabled={trimming}
                        >
                          {trimming ? <div className="spinner-small"></div> : 'Export Trimmed Clip'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="trim-section-pro-wide">
                    <div className="trim-header-studio">
                      <div className="trim-time-display">
                        <span>{formatDuration(startTime)}</span>
                        <span className="time-divider">/</span>
                        <span>{formatDuration(endTime)}</span>
                      </div>
                      <button onClick={togglePlay} className="studio-play-btn">
                        {isPlaying ? (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        )}
                        {isPlaying ? 'Pause Selection' : 'Play Selection'}
                      </button>
                    </div>

                    <div className="spectrum-container-wide" ref={spectrumRef}>
                      <div className="waveform-bg">
                        {[...Array(100)].map((_, i) => {
                          const duration = localDuration || 1;
                          const isSelected = (i / 100) * duration >= startTime && (i / 100) * duration <= endTime;
                          return <div key={i} className={`wave-bar ${isSelected ? 'active' : ''}`} style={{ height: `${20 + Math.random() * 60}%` }}></div>
                        })}
                      </div>
                      <div className="range-container-studio">
                        <div className="selection-overlay" style={{ left: `${(startTime / (localDuration || 1)) * 100}%`, width: `${((endTime - startTime) / (localDuration || 1)) * 100}%` }}></div>
                        <div className="handle-container" style={{ left: `${(startTime / (localDuration || 1)) * 100}%` }} onMouseDown={() => setDragging('start')}>
                          <div className="handle-label top">START</div>
                          <div className="handle-bar"></div>
                          <div className="handle-label bottom">{formatDuration(startTime)}</div>
                        </div>
                        <div className="handle-container" style={{ left: `${(endTime / (localDuration || 1)) * 100}%` }} onMouseDown={() => setDragging('end')}>
                          <div className="handle-label top">END</div>
                          <div className="handle-bar"></div>
                          <div className="handle-label bottom">{formatDuration(endTime)}</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {trimSuccess && (
                    <div className="success-banner padded">✨ Clip Exported! Saved to your Downloads folder.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'transfer' && <TransferTab />}
      </div>
    </div>
  );
}

export default App;
