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
  
  // Refs
  const activeEventSource = useRef(null);
  const playerRef = useRef(null);
  const inputRef = useRef(null); // Added for auto-focus
  const spectrumRef = useRef(null);
  
  // Trimming State
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [waveform, setWaveform] = useState([]);
  
  const [downloadState, setDownloadState] = useState('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState('');
  const [downloadEta, setDownloadEta] = useState('');
  const [downloadMsg, setDownloadMsg] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [dragging, setDragging] = useState(null); // 'start', 'end', or null

  // Auto-focus and Badge Clearing
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
    
    const handleFocus = () => {
      if (window.electron && window.electron.clearBadge) {
        window.electron.clearBadge();
      }
    };
    
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Sync Slider to Video Preview
  const handleSeek = (time) => {
    if (playerRef.current) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }),
        '*'
      );
    }
  };

  const togglePlay = () => {
    if (playerRef.current) {
      const command = isPlaying ? 'pauseVideo' : 'playVideo';
      if (!isPlaying) handleSeek(startTime); // Start from the beginning of the trim
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: command, args: [] }),
        '*'
      );
      setIsPlaying(!isPlaying);
    }
  };

  // Monitor playback to stay within bounds
  useEffect(() => {
    if (isPlaying && playerRef.current) {
      const interval = setInterval(() => {
        // We can't easily get current time from iframe without complex postMessage listeners,
        // so we'll rely on the user for now or keep it simple.
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isPlaying, endTime]);

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e) => {
      if (!spectrumRef.current || !metadata) return;
      const rect = spectrumRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const time = (x / rect.width) * metadata.duration;

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

    const onMouseUp = () => setDragging(null);

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragging, startTime, endTime, metadata?.duration]);

  // RESET UI IF FORMAT CHANGES
  useEffect(() => {
    setError('');
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
    setWaveform([]);
    setDownloadState('started');
    setDownloadPercent(0);
    setDownloadMsg('Initializing Engine (10%)...');

    try {
      if (window.electron && window.electron.getInfo) {
        setDownloadPercent(25);
        setDownloadMsg('Securing Connection...');
        
        const data = await window.electron.getInfo(url.trim());
        if (data.error) throw new Error(data.error);
        
        setDownloadPercent(60);
        setDownloadMsg('Generating Audio Spectrum...');

        // Fetch Real Waveform for single videos
        if (!data.isPlaylist) {
          const points = await window.electron.getWaveform(url.trim());
          setWaveform(points);
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

  const handleDownload = () => {
    if (!metadata || downloadState !== 'idle') return;

    // STOP PREVIEW PLAYBACK IF ACTIVE
    if (isPlaying && playerRef.current) {
      playerRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
        '*'
      );
      setIsPlaying(false);
    }

    setDownloadState('started');
    setDownloadPercent(5);
    setDownloadMsg('Initializing Lightning-Fast Engine...');
    
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
  };

  const handleStopQueue = () => {
    if (activeEventSource.current && activeEventSource.current.close) {
      activeEventSource.current.close();
    }
    activeEventSource.current = 'stopped';
    setDownloadState('idle');
    setLoading(false);
    setDownloadPercent(0);
    setDownloadMsg('Process stopped by user.');
  };

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
              ref={inputRef}
              type="text"
              placeholder="Paste YouTube link..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="url-input"
              disabled={isDownloading}
            />
            <button type="submit" className="analyze-btn" disabled={loading || isDownloading}>
              {loading ? <div className="spinner"></div> : 'Analyze'}
            </button>
          </div>
        </form>

        {metadata && (
          <div className="settings-section">
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
                      <option value="4k">MP4 4K</option>
                      <option value="1080p">MP4 1080p</option>
                      <option value="720p">MP4 720p</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Full-Width Wide Spectrum Trim Selector */}
              {!isDownloading && downloadState === 'idle' && (
                <div className="trim-section-pro-wide">
                  <div className="trim-header-studio">
                    <div className="studio-badge">STUDIO CUT MODE</div>
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
                      {isPlaying ? 'Pause' : 'Play Clip'}
                    </button>
                  </div>
                  
                  <div className="spectrum-container-wide" ref={spectrumRef}>
                    <div className="waveform-bg">
                      {(waveform.length > 0 ? waveform : [...Array(100)]).map((val, i) => {
                        const isSelected = (i / 100) * metadata.duration >= startTime && (i / 100) * metadata.duration <= endTime;
                        return (
                          <div 
                            key={i} 
                            className={`wave-bar ${isSelected ? 'active' : ''}`} 
                            style={{ 
                              height: waveform.length > 0 ? `${15 + val * 85}%` : `${20 + Math.random() * 40}%`
                            }}
                          ></div>
                        );
                      })}
                    </div>
                    
                    <div className="range-container-studio">
                      <div className="selection-overlay" style={{ 
                        left: `${(startTime / metadata.duration) * 100}%`,
                        right: `${100 - (endTime / metadata.duration) * 100}%`
                      }}></div>
                      
                      <div 
                        className={`handle-container ${dragging === 'start' ? 'dragging' : ''}`} 
                        style={{ left: `${(startTime / metadata.duration) * 100}%` }}
                        onMouseDown={() => setDragging('start')}
                      >
                        <div className="handle-label top">START</div>
                        <div className="handle-bar"></div>
                        <div className="handle-label bottom">{formatDuration(startTime)}</div>
                      </div>

                      <div 
                        className={`handle-container ${dragging === 'end' ? 'dragging' : ''}`} 
                        style={{ left: `${(endTime / metadata.duration) * 100}%` }}
                        onMouseDown={() => setDragging('end')}
                      >
                        <div className="handle-label top">END</div>
                        <div className="handle-bar"></div>
                        <div className="handle-label bottom">{formatDuration(endTime)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="trim-footer">
                    <span>Tip: Drag handles to select the perfect part. Length: {formatDuration(endTime - startTime)}</span>
                  </div>
                </div>
              )}
            </div>

            {downloadState === 'idle' && (
              <button onClick={handleDownload} className="download-trigger-btn">
                Start Pro Download
              </button>
            )}

            {(downloadState !== 'idle') && (
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
                  style={{ opacity: downloadState === 'completed' ? 0.5 : 1 }}
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
