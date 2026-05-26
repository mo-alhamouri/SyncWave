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
  const [format, setFormat] = useState('mp3'); // 'mp3' or 'mp4'
  
  // Ref for active SSE connection
  const activeEventSource = useRef(null);
  
  // Download progress states
  const [downloadState, setDownloadState] = useState('idle'); // idle, started, downloading, processing, completed, error
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadEta, setDownloadEta] = useState('');
  const [downloadMsg, setDownloadMsg] = useState('');
  const [activeFileId, setActiveFileId] = useState('');

  // Playlist specific states
  const [selectedItemIds, setSelectedItemIds] = useState({}); // { [id]: boolean }
  const [playlistSearch, setPlaylistSearch] = useState('');
  const [queue, setQueue] = useState([]); // array of playlist items
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueActive, setQueueActive] = useState(false);

  // History state
  const [history, setHistory] = useState([]);

  useEffect(() => {
    // Load download history from localStorage
    const saved = localStorage.getItem('yt_download_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse download history:', e);
      }
    }
  }, []);

  // Update selected checkboxes when metadata changes (auto select all on load)
  useEffect(() => {
    if (metadata && metadata.isPlaylist && metadata.entries) {
      const initialSelection = {};
      metadata.entries.forEach(e => {
        initialSelection[e.id] = true;
      });
      setSelectedItemIds(initialSelection);
    }
  }, [metadata]);

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
      const response = await fetch(`/api/info?url=${encodeURIComponent(url.trim())}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch video details.');
      }

      setMetadata(data);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error occurred while loading details.');
    } finally {
      setLoading(false);
    }
  };

  // Helper to trigger sequential queue downloading
  const processQueueItem = (index, currentQueue) => {
    // If user stopped the queue manually
    if (activeEventSource.current === 'stopped') {
      setQueueActive(false);
      setDownloadState('idle');
      return;
    }

    if (index >= currentQueue.length) {
      setQueueActive(false);
      setDownloadState('completed');
      setDownloadMsg(`All ${currentQueue.length} playlist downloads completed successfully!`);
      return;
    }

    setQueueIndex(index);
    const activeItem = currentQueue[index];
    
    // Check if item is still selected (user might have unselected it while pending)
    if (selectedItemIds[activeItem.id] === false) {
      console.log(`Skipping unselected item: ${activeItem.title}`);
      const updatedQueue = [...currentQueue];
      updatedQueue[index].status = 'skipped';
      setQueue(updatedQueue);
      processQueueItem(index + 1, updatedQueue);
      return;
    }
    
    // Update queue element state
    const updatedQueue = [...currentQueue];
    updatedQueue[index].status = 'downloading';
    setQueue(updatedQueue);

    setDownloadPercent(0);
    setDownloadSpeed('');
    setDownloadEta('');
    setDownloadMsg(`[Queue ${index + 1}/${updatedQueue.length}] Downloading: "${activeItem.title}"...`);
    setDownloadState('downloading');

    // Start SSE stream for single video in playlist
    const targetUrl = `/api/download?url=${encodeURIComponent(activeItem.url)}&format=${format}`;
    const eventSource = new EventSource(targetUrl);
    activeEventSource.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.status) {
          case 'downloading':
            setDownloadPercent(Math.floor(data.percent || 0));
            setDownloadSpeed(data.speed || '');
            setDownloadEta(data.eta || '');
            break;
          case 'processing':
            setDownloadPercent(100);
            setDownloadMsg(`[Queue ${index + 1}/${updatedQueue.length}] Encoding: "${activeItem.title}"...`);
            updatedQueue[index].status = 'processing';
            setQueue([...updatedQueue]);
            break;
          case 'completed':
            updatedQueue[index].status = 'completed';
            setQueue([...updatedQueue]);

            // Save to browser automatically
            const fileDownloadUrl = `/api/files/${data.fileId}?ext=${data.ext}&title=${encodeURIComponent(activeItem.title)}`;
            const link = document.createElement('a');
            link.href = fileDownloadUrl;
            link.setAttribute('download', `${activeItem.title}.${data.ext}`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Log in history list
            const historyItem = {
              id: activeItem.id,
              fileId: data.fileId,
              title: activeItem.title,
              thumbnail: `https://img.youtube.com/vi/${activeItem.id}/hqdefault.jpg`,
              duration: activeItem.duration,
              format: format,
              ext: data.ext,
              date: new Date().toLocaleDateString(),
              timestamp: Date.now()
            };
            setHistory(prev => {
              const next = [historyItem, ...prev];
              localStorage.setItem('yt_download_history', JSON.stringify(next));
              return next;
            });

            eventSource.close();
            activeEventSource.current = null;
            
            // Move sequentially to next item after small delay
            setTimeout(() => {
              processQueueItem(index + 1, updatedQueue);
            }, 1200);
            break;
          case 'error':
            updatedQueue[index].status = 'error';
            setQueue([...updatedQueue]);
            eventSource.close();
            activeEventSource.current = null;
            // Move to next anyway to prevent blocking
            setTimeout(() => {
              processQueueItem(index + 1, updatedQueue);
            }, 2000);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('SSE JSON error:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE connection error:', err);
      updatedQueue[index].status = 'error';
      setQueue([...updatedQueue]);
      eventSource.close();
      activeEventSource.current = null;
      setTimeout(() => {
        processQueueItem(index + 1, updatedQueue);
      }, 2000);
    };
  };

  const handleStopQueue = () => {
    if (activeEventSource.current && activeEventSource.current !== 'stopped') {
      if (activeEventSource.current instanceof EventSource) {
        activeEventSource.current.close();
      }
    }
    activeEventSource.current = 'stopped';
    setQueueActive(false);
    setDownloadState('idle');
    setDownloadMsg('Download process stopped by user.');
  };

  const handleDownload = () => {
    if (!metadata || downloadState === 'downloading' || downloadState === 'processing' || queueActive) return;

    if (metadata.isPlaylist) {
      const selectedItems = metadata.entries.filter(item => selectedItemIds[item.id]);
      if (selectedItems.length === 0) {
        setError('Please select at least one video in the playlist to download.');
        return;
      }

      setError('');
      activeEventSource.current = null; // Reset stop state
      const initialQueue = selectedItems.map(item => ({
        ...item,
        status: 'pending'
      }));

      setQueue(initialQueue);
      setQueueActive(true);
      setQueueIndex(0);
      processQueueItem(0, initialQueue);
    } else {
      // Single video download logic
      setDownloadState('started');
      setDownloadPercent(0);
      setDownloadSpeed('');
      setDownloadEta('');
      setDownloadMsg('Preparing downloader...');
      setError('');

      const targetUrl = `/api/download?url=${encodeURIComponent(url.trim())}&format=${format}`;
      const eventSource = new EventSource(targetUrl);
      activeEventSource.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.status) {
            case 'started':
              setDownloadState('started');
              setDownloadMsg(data.message);
              break;
            case 'downloading':
              setDownloadState('downloading');
              setDownloadPercent(Math.floor(data.percent || 0));
              setDownloadSpeed(data.speed || '');
              setDownloadEta(data.eta || '');
              setDownloadMsg('Downloading streams from YouTube...');
              break;
            case 'processing':
              setDownloadState('processing');
              setDownloadPercent(100);
              setDownloadMsg(data.message || 'Processing and encoding file...');
              break;
            case 'completed':
              setDownloadState('completed');
              setDownloadMsg('Download ready! Transferring file...');
              setActiveFileId(data.fileId);
              
              // Trigger automatic file download in browser
              const downloadUrl = `/api/files/${data.fileId}?ext=${data.ext}&title=${encodeURIComponent(metadata.title)}`;
              const link = document.createElement('a');
              link.href = downloadUrl;
              link.setAttribute('download', `${metadata.title}.${data.ext}`);
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);

              // Update session history
              const historyItem = {
                id: metadata.id,
                fileId: data.fileId,
                title: metadata.title,
                thumbnail: metadata.thumbnail,
                duration: metadata.duration,
                format: format,
                ext: data.ext,
                date: new Date().toLocaleDateString(),
                timestamp: Date.now()
              };
              const updatedHistory = [historyItem, ...history];
              setHistory(updatedHistory);
              localStorage.setItem('yt_download_history', JSON.stringify(updatedHistory));

              eventSource.close();
              activeEventSource.current = null;
              break;
            case 'error':
              setDownloadState('error');
              setError(data.error || 'An error occurred during download conversion.');
              eventSource.close();
              activeEventSource.current = null;
              break;
            default:
              break;
          }
        } catch (e) {
          console.error('Error parsing SSE data:', e);
        }
      };

      eventSource.onerror = (err) => {
        console.error('EventSource error:', err);
        setDownloadState('error');
        setError('Connection to downloader service was interrupted.');
        eventSource.close();
        activeEventSource.current = null;
      };
    }
  };

  const handleRedownload = (item) => {
    setUrl(`https://www.youtube.com/watch?v=${item.id}`);
    setFormat(item.format);
    
    // Direct server save request if available
    const downloadUrl = `/api/files/${item.fileId}?ext=${item.ext}&title=${encodeURIComponent(item.title)}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.setAttribute('download', `${item.title}.${item.ext}`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleSelectItem = (id) => {
    // Only allow toggling if queue isn't active, 
    // OR if queue is active but the specific item is still 'pending'
    if (queueActive) {
      const queueItem = queue.find(q => q.id === id);
      if (!queueItem || queueItem.status !== 'pending') return;
    }

    setSelectedItemIds(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleSelectAll = (filteredEntries) => {
    if (queueActive) return;
    const allSelected = filteredEntries.every(item => selectedItemIds[item.id]);
    const nextSelection = { ...selectedItemIds };
    
    filteredEntries.forEach(item => {
      nextSelection[item.id] = !allSelected;
    });
    setSelectedItemIds(nextSelection);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('yt_download_history');
  };

  // Filtered list of playlist entries
  const filteredPlaylistEntries = metadata && metadata.isPlaylist && metadata.entries 
    ? metadata.entries.filter(item => item.title.toLowerCase().includes(playlistSearch.toLowerCase()))
    : [];

  const selectedCount = metadata && metadata.isPlaylist
    ? Object.values(selectedItemIds).filter(Boolean).length
    : 0;

  return (
    <div className="app-container">
      <header className="header-section">
        <h1>
          <span className="gradient-text">SyncWave</span> Downloader
        </h1>
        <p>
          Convert and save any YouTube video or entire playlists into high-quality MP3 or MP4 formats instantly. Fully local and lightning-fast.
        </p>
      </header>

      {/* Main Analyzer Input Panel */}
      <div className="glass-panel pulse-glow">
        <form onSubmit={handleAnalyze}>
          <div className="input-wrapper">
            <svg style={{ alignSelf: 'center', marginLeft: '12px', fill: 'var(--text-muted)' }} width="20" height="20" viewBox="0 0 24 24">
              <path d="M22.26 14.59c-.48-.28-1.5-.72-2.73-1.09-1.01-.3-2.14-.54-3.19-.71-.85-.14-1.63-.22-2.31-.22-.38 0-.74.02-1.07.05v-5.2c.49-.03.95-.05 1.39-.05.81 0 1.63.07 2.44.2.98.16 2.02.39 2.94.67.92.28 1.76.62 2.22.86.31.16.51.49.51.84v4.06c0 .24-.09.47-.26.6-.16.14-.38.18-.59.1-.03-.01-.06-.02-.1-.05zM2 17.5v-11c0-.83.67-1.5 1.5-1.5h11c.83 0 1.5.67 1.5 1.5v11c0 .83-.67 1.5-1.5 1.5h-11C2.67 19 2 18.33 2 17.5zm10.5-5.5c0-1.38-1.12-2.5-2.5-2.5S7.5 10.62 7.5 12s1.12 2.5 2.5 2.5 2.5-1.12 2.5-2.5z"/>
            </svg>
            <input
              type="text"
              className="url-input"
              placeholder="Paste YouTube video or playlist URL here..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading || downloadState === 'downloading' || downloadState === 'processing' || queueActive}
            />
            <button
              type="submit"
              className="analyze-button"
              disabled={loading || !url.trim() || downloadState === 'downloading' || downloadState === 'processing' || queueActive}
            >
              {loading ? (
                <>
                  <div className="spinner"></div>
                  Analyzing...
                </>
              ) : (
                'Analyze'
              )}
            </button>
          </div>
        </form>

        {error && (
          <div className="alert-message alert-error">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Video / Playlist Details */}
        {metadata && (
          <div className="settings-section">
            
            {/* PLAYLIST DISPLAY CARD */}
            {metadata.isPlaylist ? (
              <div className="playlist-layout">
                {/* Playlist Summary on Left */}
                <div className="playlist-info-panel">
                  <div className="playlist-meta-info">
                    <span className="playlist-meta-title">{metadata.title}</span>
                    <div className="playlist-meta-channel">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/>
                      </svg>
                      {metadata.channel}
                    </div>
                    <span className="playlist-meta-count">
                      <strong>Total:</strong> {metadata.videoCount} Tracks
                    </span>
                    <span className="playlist-meta-count">
                      <strong>Selected:</strong> {selectedCount} Tracks
                    </span>
                  </div>

                  {!queueActive && downloadState === 'idle' && (
                    <div className="format-picker" style={{ flexDirection: 'column' }}>
                      <button
                        type="button"
                        className={`format-btn ${format === 'mp3' ? 'active' : ''}`}
                        onClick={() => setFormat('mp3')}
                      >
                        <span className="format-title">MP3 Audio</span>
                      </button>
                      <button
                        type="button"
                        className={`format-btn ${format === 'mp4' ? 'active' : ''}`}
                        onClick={() => setFormat('mp4')}
                      >
                        <span className="format-title">MP4 Video</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Scrollable Playlist Table on Right */}
                <div>
                  <div className="playlist-list-header">
                    <span className="playlist-select-text">Select tracks to save:</span>
                    <button
                      type="button"
                      className="playlist-select-all-btn"
                      onClick={() => handleSelectAll(filteredPlaylistEntries)}
                      disabled={queueActive}
                    >
                      {filteredPlaylistEntries.every(e => selectedItemIds[e.id]) ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  
                  <input
                    type="text"
                    className="playlist-search-box"
                    placeholder="Search tracks in playlist..."
                    value={playlistSearch}
                    onChange={(e) => setPlaylistSearch(e.target.value)}
                    style={{ marginBottom: '0.8rem' }}
                    disabled={queueActive}
                  />

                  <div className="playlist-scroll-list">
                    {filteredPlaylistEntries.map((item, idx) => {
                      const isSelected = !!selectedItemIds[item.id];
                      
                      // Identify current queue element status
                      let queueStatus = 'pending';
                      let activeQueueItemIdx = -1;
                      
                      if (queueActive) {
                        activeQueueItemIdx = queue.findIndex(q => q.id === item.id);
                        if (activeQueueItemIdx !== -1) {
                          queueStatus = queue[activeQueueItemIdx].status;
                        }
                      }

                      const isCurrentlyDownloading = queueActive && activeQueueItemIdx === queueIndex;

                      return (
                        <div
                          key={item.id}
                          className={`playlist-row-item ${isSelected ? 'selected' : ''} ${isCurrentlyDownloading ? 'active-downloading' : ''}`}
                          onClick={() => toggleSelectItem(item.id)}
                        >
                          <div className={`playlist-row-checkbox ${isSelected ? 'checked' : ''}`}>
                            {isSelected && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"></polyline>
                              </svg>
                            )}
                          </div>
                          
                          <span className="playlist-row-index">{item.index}</span>
                          <span className="playlist-row-title" title={item.title}>{item.title}</span>
                          
                          {queueActive && activeQueueItemIdx !== -1 ? (
                            <span className={`playlist-row-badge badge-${queueStatus}`}>
                              {queueStatus === 'downloading' ? 'active' : queueStatus}
                            </span>
                          ) : (
                            <span className="playlist-row-duration">{formatDuration(item.duration)}</span>
                          )}
                        </div>
                      );
                    })}

                    {filteredPlaylistEntries.length === 0 && (
                      <div className="empty-state" style={{ padding: '2rem' }}>
                        No tracks match your search query.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              
              /* SINGLE VIDEO PREVIEW CARD */
              <div className="preview-card">
                <div className="thumbnail-container">
                  <img
                    className="thumbnail-img"
                    src={metadata.thumbnail}
                    alt={metadata.title}
                  />
                  <span className="duration-tag">{formatDuration(metadata.duration)}</span>
                </div>
                
                <div className="video-info-content">
                  <div>
                    <h3 className="video-title">{metadata.title}</h3>
                    <div className="video-channel">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                      </svg>
                      {metadata.channel}
                    </div>
                    <div className="video-meta-row">
                      <span>
                        <strong>Views:</strong> {formatViews(metadata.viewCount)}
                      </span>
                      <span>•</span>
                      <span>
                        <strong>Format:</strong> High-Definition
                      </span>
                    </div>
                  </div>

                  {downloadState === 'idle' && (
                    <div className="format-picker">
                      <button
                        type="button"
                        className={`format-btn ${format === 'mp3' ? 'active' : ''}`}
                        onClick={() => setFormat('mp3')}
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 18V5l12-2v13"></path>
                          <circle cx="6" cy="18" r="3"></circle>
                          <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                        <span className="format-title">Audio (MP3)</span>
                        <span className="format-desc">Best quality music rip</span>
                      </button>
                      
                      <button
                        type="button"
                        className={`format-btn ${format === 'mp4' ? 'active' : ''}`}
                        onClick={() => setFormat('mp4')}
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                          <line x1="7" y1="2" x2="7" y2="22"></line>
                          <line x1="17" y1="2" x2="17" y2="22"></line>
                          <line x1="2" y1="12" x2="22" y2="12"></line>
                          <line x1="2" y1="7" x2="7" y2="7"></line>
                          <line x1="2" y1="17" x2="7" y2="17"></line>
                          <line x1="17" y1="17" x2="22" y2="17"></line>
                          <line x1="17" y1="7" x2="22" y2="7"></line>
                        </svg>
                        <span className="format-title">Video (MP4)</span>
                        <span className="format-desc">Full 1080p stream fusion</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Direct Download trigger button */}
            {downloadState === 'idle' && !queueActive && (
              <button
                type="button"
                className="download-trigger-btn"
                onClick={handleDownload}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <polyline points="19 12 12 19 5 12"></polyline>
                </svg>
                {metadata.isPlaylist 
                  ? `Download Selected (${selectedCount} Tracks as ${format.toUpperCase()})` 
                  : `Download Now (${format.toUpperCase()})`
                }
              </button>
            )}

            {/* Active Download Progress Dashboard (Dynamic for single or queue) */}
            {(downloadState !== 'idle' || queueActive) && downloadState !== 'error' && (
              <div className="progress-panel">
                <div className="progress-header">
                  <span className="progress-status">
                    {(downloadState === 'started' || downloadState === 'downloading' || queueActive) && <div className="spinner"></div>}
                    {downloadState === 'completed' && !queueActive && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--success)">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                      </svg>
                    )}
                    {downloadMsg}
                  </span>
                  <span className="progress-pct">{downloadPercent}%</span>
                </div>
                
                <div className="progress-bar-bg">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${downloadPercent}%` }}
                  ></div>
                </div>

                {(downloadState === 'downloading' || downloadState === 'processing') && (
                  <div className="progress-stats-row">
                    <div className="progress-stat-item">
                      Speed: <span className="progress-stat-value">{downloadSpeed || 'N/A'}</span>
                    </div>
                    <div className="progress-stat-item">
                      Time Remaining: <span className="progress-stat-value">{downloadEta || 'Estimating...'}</span>
                    </div>
                  </div>
                )}

                {downloadState === 'completed' && !queueActive && (
                  <div className="alert-message alert-success">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                    </svg>
                    <span>Your downloads completed successfully! Files have been saved automatically.</span>
                  </div>
                )}

                {(downloadState === 'downloading' || downloadState === 'processing' || queueActive) && downloadState !== 'completed' && (
                  <button
                    type="button"
                    className="stop-button"
                    onClick={handleStopQueue}
                    style={{
                      marginTop: '1rem',
                      width: '100%',
                      padding: '0.6rem',
                      background: 'rgba(255, 68, 68, 0.1)',
                      color: '#ff4444',
                      border: '1px solid rgba(255, 68, 68, 0.3)',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px'
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop Process
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Local Session Download History */}
      <div className="glass-panel">
        <div className="history-section">
          <div className="history-header">
            <span>Recent Downloads</span>
            {history.length > 0 && (
              <button onClick={clearHistory} className="clear-btn">
                Clear Session
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="empty-state">
              No recent downloads in this session. Paste a YouTube link above to get started!
            </div>
          ) : (
            <div className="history-list">
              {history.map((item) => (
                <div key={item.timestamp} className="history-item">
                  <div className="history-info">
                    <img
                      className="history-thumbnail"
                      src={item.thumbnail}
                      alt={item.title}
                    />
                    <div className="history-text">
                      <span className="history-title" title={item.title}>{item.title}</span>
                      <div className="history-meta">
                        <span className={`badge badge-${item.format}`}>
                          {item.format}
                        </span>
                        <span>•</span>
                        <span>{formatDuration(item.duration)}</span>
                        <span>•</span>
                        <span>{item.date}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="history-actions">
                    <button
                      onClick={() => handleRedownload(item)}
                      className="download-again-btn"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                      </svg>
                      Retrieve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
