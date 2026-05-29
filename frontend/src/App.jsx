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
  const [format, setFormat] = useState('mp3-320'); // Studio default
  
  const activeEventSource = useRef(null);
  
  // Download progress states
  const [downloadState, setDownloadState] = useState('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadEta, setDownloadEta] = useState('');
  const [downloadMsg, setDownloadMsg] = useState('');
  const [activeFileId, setActiveFileId] = useState('');

  // Playlist states
  const [selectedItemIds, setSelectedItemIds] = useState({});
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueActive, setQueueActive] = useState(false);

  const [history, setHistory] = useState([]);

  useEffect(() => {
    const saved = localStorage.getItem('syncwave_history');
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  const handleAnalyze = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');
    setMetadata(null);
    setDownloadState('idle');
    setQueueActive(false);
    setQueue([]);

    try {
      if (window.electron && window.electron.getInfo) {
        const data = await window.electron.getInfo(url.trim());
        if (data.error) throw new Error(data.error);
        
        // Auto-select all for playlists
        if (data.isPlaylist) {
          const selection = {};
          data.entries.forEach(item => selection[item.id] = true);
          setSelectedItemIds(selection);
        }
        
        setMetadata(data);
      }
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error occurred while loading details.');
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
      setDownloadMsg(`All ${currentQueue.length} downloads completed!`);
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
          setDownloadPercent(100);
          updatedQueue[index].status = 'processing';
          setQueue([...updatedQueue]);
        } else {
          setDownloadPercent(Math.floor(data.percent || 0));
          setDownloadSpeed(data.speed || '');
          setDownloadEta(data.eta || '');
        }
      });

      const removeCompletedListener = window.electron.onDownloadCompleted(() => {
        cleanup();
        updatedQueue[index].status = 'completed';
        setQueue([...updatedQueue]);

        const historyItem = {
          id: activeItem.id,
          title: activeItem.title,
          thumbnail: `https://i.ytimg.com/vi/${activeItem.id}/hqdefault.jpg`,
          duration: activeItem.duration,
          format: format,
          date: new Date().toLocaleDateString(),
          timestamp: Date.now()
        };
        
        setHistory(prev => {
          const next = [historyItem, ...prev];
          localStorage.setItem('syncwave_history', JSON.stringify(next));
          return next;
        });

        setTimeout(() => processQueueItem(index + 1, updatedQueue), 800);
      });

      const removeErrorListener = window.electron.onDownloadError((data) => {
        cleanup();
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
      setDownloadMsg('Initializing Lightning-Fast Engine...');
      
      if (window.electron && window.electron.download) {
        window.electron.download(url.trim(), format);
        
        const removeProgressListener = window.electron.onDownloadProgress((data) => {
          if (data.status === 'processing') {
            setDownloadState('processing');
            setDownloadPercent(100);
            setDownloadMsg('Studio Quality Encoding...');
          } else {
            setDownloadState('downloading');
            setDownloadPercent(Math.floor(data.percent || 0));
            setDownloadSpeed(data.speed || '');
            setDownloadEta(data.eta || '');
            setDownloadMsg('Downloading Ultra-HD Streams...');
          }
        });

        const removeCompletedListener = window.electron.onDownloadCompleted(() => {
          cleanup();
          setDownloadState('completed');
          setDownloadMsg('Download Complete! Saved to SyncWave folder.');
          
          const historyItem = {
            id: metadata.id,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            duration: metadata.duration,
            format: format,
            date: new Date().toLocaleDateString(),
            timestamp: Date.now()
          };
          setHistory(prev => {
            const next = [historyItem, ...prev];
            localStorage.setItem('syncwave_history', JSON.stringify(next));
            return next;
          });
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

  return (
    <div className="app-container">
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
            />
            <button type="submit" className="analyze-btn" disabled={loading}>
              {loading ? <div className="spinner"></div> : 'Analyze'}
            </button>
          </div>
        </form>

        {error && <div className="alert-message alert-error">{error}</div>}

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
                      <select value={format} onChange={(e) => setFormat(e.target.value)} className="quality-select">
                        <optgroup label="Studio Audio">
                          <option value="mp3-320">MP3 320kbps (Studio)</option>
                          <option value="flac">FLAC Lossless</option>
                          <option value="wav">WAV Uncompressed</option>
                          <option value="aac">AAC Enhanced</option>
                        </optgroup>
                        <optgroup label="Ultra-HD Video">
                          <option value="4k">MP4 4K Ultra-HD</option>
                          <option value="1440p">MP4 1440p QHD</option>
                          <option value="1080p">MP4 1080p Full-HD</option>
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
                        <span className="playlist-row-title">{item.title}</span>
                        <span className="playlist-row-duration">{formatDuration(item.duration)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="preview-card">
                <div className="thumbnail-container">
                  <img src={metadata.thumbnail} alt="Preview" className="thumbnail-img" />
                  <span className="duration-tag">{formatDuration(metadata.duration)}</span>
                </div>
                
                <div className="video-info-content">
                  <div style={{ minWidth: 0 }}>
                    <h3 className="video-title" title={metadata.title}>{metadata.title}</h3>
                    <div className="video-channel">{metadata.channel}</div>
                    <div className="video-meta-row">
                      <span>{formatViews(metadata.viewCount)} views</span>
                      <span>•</span>
                      <select value={format} onChange={(e) => setFormat(e.target.value)} className="quality-select-inline">
                        <option value="mp3-320">MP3 320kbps</option>
                        <option value="flac">FLAC Lossless</option>
                        <option value="4k">MP4 4K</option>
                        <option value="1080p">MP4 1080p</option>
                      </select>
                    </div>
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
                  <span className="progress-pct">{downloadPercent}%</span>
                </div>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${downloadPercent}%` }}></div></div>
                <button onClick={() => activeEventSource.current.close()} className="stop-button">Stop Process</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="glass-panel">
        <div className="history-header">Recent Downloads</div>
        <div className="history-list">
          {history.map(item => (
            <div key={item.timestamp} className="history-item">
              <img src={item.thumbnail} className="history-thumbnail" alt="" />
              <div className="history-text">
                <span className="history-title">{item.title}</span>
                <span className="history-meta">{item.format.toUpperCase()} • {item.date}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
