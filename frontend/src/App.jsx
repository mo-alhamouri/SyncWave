import React, { useState, useEffect, useRef } from 'react';

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
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [error, setError] = useState('');
  const [format, setFormat] = useState('mp3-320');
  
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  
  const activeEventSource = useRef(null);
  const playerRef = useRef(null); // Ref for YouTube player
  
  const [downloadState, setDownloadState] = useState('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadEta, setDownloadEta] = useState('');
  const [downloadMsg, setDownloadMsg] = useState('');

  // Sync Slider to Video Preview
  const handleSeek = (time) => {
    if (playerRef.current) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }),
        '*'
      );
    }
  };

  useEffect(() => {
    setError('');
    if (downloadState === 'completed' || downloadState === 'error') {
      setDownloadState('idle');
      setDownloadMsg('');
      setDownloadPercent(0);
    }
  }, [format]);

  // Playlist states
  const [selectedItemIds, setSelectedItemIds] = useState({});
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueActive, setQueueActive] = useState(false);

  // RESET UI IF FORMAT CHANGES
  useEffect(() => {
    setError(''); // Remove displayed error on format change
    
    if (downloadState === 'completed' || downloadState === 'error') {
      setDownloadState('idle');
      setDownloadMsg('');
      setDownloadPercent(0);
    }
  }, [format]);

  const handleAnalyze = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');
    setMetadata(null);
    setDownloadState('started');
    setDownloadPercent(0);
    setDownloadMsg('Initializing Engine (10%)...');
    setQueueActive(false);
    setQueue([]);

    try {
      if (window.electron && window.electron.getInfo) {
        setDownloadPercent(25);
        setDownloadMsg('Securing Connection (25%)...');
        await new Promise(r => setTimeout(r, 400));
        setDownloadPercent(45);
        setDownloadMsg('Analyzing Metadata (45%)...');

        const data = await window.electron.getInfo(url.trim());
        if (data.error) throw new Error(data.error);
        
        setDownloadPercent(85);
        setDownloadMsg('Mapping High-Quality Streams (85%)...');

        if (data.isPlaylist) {
          const selection = {};
          data.entries.forEach(item => selection[item.id] = true);
          setSelectedItemIds(selection);
        } else {
          setStartTime(0);
          setEndTime(data.duration || 0);
        }
        
        setDownloadPercent(100);
        setDownloadMsg('Analysis Complete!');
        await new Promise(r => setTimeout(r, 600));
        
        setMetadata(data);
        setDownloadState('idle');
        setDownloadPercent(0);
      }
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error occurred while loading details.');
      setDownloadState('idle');
    } finally {
      setLoading(false);
    }
  };

  const processQueueItem = (index, currentQueue) => {
    if (activeEventSource.current === 'stopped') {
      setQueueActive(false);
      setDownloadState('idle');
      return;
    }

    if (index >= currentQueue.length) {
      setQueueActive(false);
      setDownloadState('completed');
      setDownloadMsg(`All ${currentQueue.length} downloads completed`);
      setDownloadPercent(100);
      return;
    }

    setQueueIndex(index);
    const activeItem = currentQueue[index];
    
    if (selectedItemIds[activeItem.id] === false) {
      const updatedQueue = [...currentQueue];
      updatedQueue[index].status = 'skipped';
      setQueue(updatedQueue);
      processQueueItem(index + 1, updatedQueue);
      return;
    }
    
    const updatedQueue = [...currentQueue];
    updatedQueue[index].status = 'downloading';
    setQueue(updatedQueue);

    setDownloadPercent(0);
    setDownloadSpeed('');
    setDownloadEta('');
    setDownloadMsg(`[${index + 1}/${updatedQueue.length}] Processing: ${activeItem.title}`);
    setDownloadState('downloading');

    if (window.electron && window.electron.download) {
      window.electron.download(activeItem.url, format);
      
      const removeProgressListener = window.electron.onDownloadProgress((data) => {
        if (data.status === 'processing') {
          setDownloadPercent(95);
          setDownloadMsg(`[${index + 1}/${updatedQueue.length}] Finalizing: ${activeItem.title}`);
          updatedQueue[index].status = 'processing';
          setQueue([...updatedQueue]);
        } else {
          const progress = Math.max(10, Math.floor(data.percent || 0));
          setDownloadPercent(progress);
        }
      });

      const removeCompletedListener = window.electron.onDownloadCompleted(() => {
        cleanup();
        updatedQueue[index].status = 'completed';
        setQueue([...updatedQueue]);
        setTimeout(() => processQueueItem(index + 1, updatedQueue), 800);
      });

      const removeErrorListener = window.electron.onDownloadError((data) => {
        cleanup();
        setError(data.error);
        updatedQueue[index].status = 'error';
        setQueue([...updatedQueue]);
        setTimeout(() => processQueueItem(index + 1, updatedQueue), 1500);
      });

      const cleanup = () => {
        removeProgressListener();
        removeCompletedListener();
        removeErrorListener();
      };

      activeEventSource.current = { close: () => window.electron.stopDownload() };
    }
  };

  const handleDownload = () => {
    if (!metadata || queueActive) return;

    if (metadata.isPlaylist) {
      const selectedItems = metadata.entries.filter(item => selectedItemIds[item.id]);
      if (selectedItems.length === 0) return setError('Select at least one track.');

      setError('');
      activeEventSource.current = null;
      const initialQueue = selectedItems.map(item => ({ ...item, status: 'pending' }));
      setQueue(initialQueue);
      setQueueActive(true);
      setQueueIndex(0);
      processQueueItem(0, initialQueue);
    } else {
      setDownloadState('started');
      setDownloadPercent(5);
      setDownloadMsg('Initializing Engine (5%)...');
      
      if (window.electron && window.electron.download) {
        window.electron.download(url.trim(), format, startTime, endTime);
        
        const removeProgressListener = window.electron.onDownloadProgress((data) => {
          if (data.status === 'processing') {
            setDownloadState('processing');
            setDownloadPercent(95);
            setDownloadMsg('Finalizing & Encoding High-Quality File...');
          } else {
            setDownloadState('downloading');
            const progress = Math.max(10, Math.floor(data.percent || 0));
            setDownloadPercent(progress);
            setDownloadMsg('Downloading Streams from YouTube...');
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
          setDownloadState('error');
          setError(data.error || 'Download failed.');
        });

        const cleanup = () => {
          removeProgressListener();
          removeCompletedListener();
          removeErrorListener();
        };

        activeEventSource.current = { close: () => window.electron.stopDownload() };
      }
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

  const toggleSelectItem = (id) => {
    if (queueActive) {
      const item = queue.find(q => q.id === id);
      if (!item || item.status !== 'pending') return;
    }
    setSelectedItemIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSelectAll = (items) => {
    const allOn = items.every(item => selectedItemIds[item.id]);
    const next = { ...selectedItemIds };
    items.forEach(item => next[item.id] = !allOn);
    setSelectedItemIds(next);
  };

  const filteredPlaylistEntries = metadata?.isPlaylist 
    ? metadata.entries.filter(e => e.title.toLowerCase().includes(playlistSearch.toLowerCase()))
    : [];

  const isDownloading = downloadState !== 'idle' && downloadState !== 'completed' && downloadState !== 'error';

  return (
    <div className="app-container">
      {/* Error Notification Popover */}
      {error && (
        <div className="error-popover">
          <div className="error-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{error}</span>
          </div>
          <button onClick={() => setError('')} className="error-close-btn">&times;</button>
        </div>
      )}

      <div className="header-section">
        <h1>SyncWave <span className="gradient-text">Downloader</span></h1>
        <p>Unmatched Quality. Universal Compatibility. Lightning Fast.</p>
      </div>

      <div className="glass-panel main-panel">
        <form onSubmit={handleAnalyze} className="url-form">
          <div className="input-group">
            <input
              type="text"
              placeholder="Paste YouTube video or playlist link..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="url-input"
              disabled={isDownloading || queueActive}
            />
            <button type="submit" className="analyze-btn" disabled={loading || isDownloading || queueActive}>
              {loading ? <div className="spinner"></div> : 'Analyze'}
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
                    <div className="playlist-meta-channel">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                      </svg>
                      {metadata.channel}
                    </div>
                  </div>

                  {!queueActive && (
                    <div className="format-grid">
                      <select 
                        value={format} 
                        onChange={(e) => setFormat(e.target.value)} 
                        className="quality-select"
                        disabled={isDownloading}
                      >
                        <optgroup label="Studio Audio">
                          <option value="mp3-320">MP3 320kbps (Studio)</option>
                          <option value="wav">WAV Uncompressed</option>
                          <option value="aac">AAC Enhanced</option>
                        </optgroup>
                        <optgroup label="Ultra-HD Video">
                          <option value="4k">MP4 4K Ultra-HD</option>
                          <option value="1440p">MP4 1440p QHD</option>
                          <option value="1080p">MP4 1080p Full-HD</option>
                          <option value="720p">MP4 720p HD</option>
                        </optgroup>
                      </select>
                    </div>
                  )}
                </div>

                <div className="playlist-list-container">
                  <div className="playlist-list-header">
                    <span>Select tracks to save:</span>
                    <button onClick={() => handleSelectAll(filteredPlaylistEntries)} className="playlist-select-all-btn">
                      {filteredPlaylistEntries.every(e => selectedItemIds[e.id]) ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  
                  <div className="playlist-scroll-list">
                    {filteredPlaylistEntries.map((item) => (
                      <div key={item.id} className={`playlist-row-item ${selectedItemIds[item.id] ? 'selected' : ''}`} onClick={() => toggleSelectItem(item.id)}>
                        <div className={`playlist-row-checkbox ${selectedItemIds[item.id] ? 'checked' : ''}`}></div>
                        <span className="playlist-row-title" title={item.title}>{item.title}</span>
                        <span className="playlist-row-duration">{formatDuration(item.duration)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="preview-card-pro">
                <div className="video-player-container">
                  <iframe
                    ref={playerRef}
                    className="preview-player"
                    src={`https://www.youtube.com/embed/${metadata.id}?enablejsapi=1&rel=0&modestbranding=1`}
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  ></iframe>
                </div>
                
                <div className="video-info-content">
                  <div style={{ minWidth: 0 }}>
                    <h3 className="video-title" title={metadata.title}>{metadata.title}</h3>
                    <div className="video-channel">{metadata.channel}</div>
                    
                    <div className="video-meta-row">
                      <span>{formatViews(metadata.viewCount)} views</span>
                      <span>•</span>
                      <select 
                        value={format} 
                        onChange={(e) => setFormat(e.target.value)} 
                        className="quality-select-inline"
                        disabled={isDownloading}
                      >
                        <option value="mp3-320">MP3 320kbps</option>
                        <option value="wav">WAV Studio</option>
                        <option value="4k">MP4 4K</option>
                        <option value="1080p">MP4 1080p</option>
                        <option value="720p">MP4 720p</option>
                      </select>
                    </div>

                    {/* Pro Trim Selector with Visual Spectrum */}
                    {!isDownloading && downloadState === 'idle' && (
                      <div className="trim-section-pro">
                        <div className="trim-header">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 3v12"/><path d="M18 9v12"/><path d="M2 12h20"/><path d="M6 12v6a2 2 0 0 0 2 2h12"/>
                          </svg>
                          <span>Studio Cut: {formatDuration(startTime)} - {formatDuration(endTime)}</span>
                        </div>
                        
                        <div className="spectrum-container">
                          {/* Visual Waveform Placeholder */}
                          <div className="waveform-bg">
                            {[...Array(60)].map((_, i) => (
                              <div 
                                key={i} 
                                className="wave-bar" 
                                style={{ 
                                  height: `${20 + Math.random() * 80}%`,
                                  opacity: (i / 60) * metadata.duration >= startTime && (i / 60) * metadata.duration <= endTime ? 1 : 0.2
                                }}
                              ></div>
                            ))}
                          </div>
                          
                          <div className="range-container">
                            <input 
                              type="range" min="0" max={metadata.duration} value={startTime} 
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setStartTime(Math.min(val, endTime - 1));
                                handleSeek(val);
                              }}
                              className="range-input start-handle"
                            />
                            <input 
                              type="range" min="0" max={metadata.duration} value={endTime} 
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setEndTime(Math.max(val, startTime + 1));
                                handleSeek(val);
                              }}
                              className="range-input end-handle"
                            />
                          </div>
                        </div>
                        <div className="trim-hint">Drag handles to trim. Only the selected range will be downloaded.</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!queueActive && downloadState === 'idle' && (
              <button onClick={handleDownload} className="download-trigger-btn">
                Start Pro Download
              </button>
            )}

            {(downloadState !== 'idle' || queueActive) && (
              <div className="progress-panel">
                <div className="progress-header">
                  <span>{downloadMsg}</span>
                  {(downloadState === 'downloading' || downloadState === 'processing') && (
                    <span className="progress-pct">{downloadPercent}%</span>
                  )}
                </div>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${downloadPercent}%` }}></div></div>
                <button 
                  onClick={handleStopQueue} 
                  className="stop-button"
                  disabled={downloadState === 'completed'}
                  style={{ opacity: downloadState === 'completed' ? 0.5 : 1, cursor: downloadState === 'completed' ? 'not-allowed' : 'pointer' }}
                >
                  Stop Process
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
