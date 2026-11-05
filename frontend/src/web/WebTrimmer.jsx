import { useState, useEffect, useEffectEvent, useRef, useImperativeHandle } from 'react';
import TrimWaveform from '../shared/TrimWaveform.jsx';
import { formatDuration, formatPrecise, MEDIA_EXT, AUDIO_EXT } from '../shared/format.js';
import { BASE, pickFile, getFile, registerFile, decodeFile, waveform } from './platform.js';
import { trimFile, saveBlob } from './ffmpeg.js';

// Web version of the desktop app's Clip Trimmer: same screen and the same
// FFmpeg commands, run in the browser (ffmpeg.wasm). Files never leave the
// user's computer.

const WAVE_MAX_BYTES = 400 * 1024 * 1024; // bigger files: skip the waveform (too much memory)

export default function WebTrimmer({ ref, active, showToast }) {
  const [file, setFile] = useState(null); // { path, name }
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [waveData, setWaveData] = useState(null);
  const [waveLoading, setWaveLoading] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [trimMsg, setTrimMsg] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  const spectrumRef = useRef(null);
  const raf = useRef(null);
  const loadId = useRef(0);

  const isAudio = file && AUDIO_EXT.test(file.name);
  const player = () => (isAudio ? audioRef.current : videoRef.current);

  const stopPlayback = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    [audioRef.current, videoRef.current].forEach((p) => { try { if (p) p.pause(); } catch { /* gone */ } });
    setIsPlaying(false);
  };

  // Lets the page pause playback when the user switches tabs.
  useImperativeHandle(ref, () => ({ pause: stopPlayback }));
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const loadFile = async (f) => {
    if (!f) return;
    if (!MEDIA_EXT.test(f.name)) {
      showToast('That file type is not supported. Use an audio or video file (MP4, MP3, MOV, WAV, M4A...).');
      return;
    }
    stopPlayback();
    const id = ++loadId.current;
    const real = getFile(f.path);
    setFile(f);
    setUrl(URL.createObjectURL(real));
    setTrimMsg('');
    setStartTime(0); setEndTime(0); setPlayhead(0); setDuration(0);
    setWaveData(null);
    if (real.size > WAVE_MAX_BYTES) return;
    setWaveLoading(true);
    try {
      const audio = await decodeFile(real);
      if (id === loadId.current) setWaveData(waveform([audio.left, audio.right]));
    } catch { /* no waveform for this file; trimming still works */ }
    if (id === loadId.current) setWaveLoading(false);
  };

  const chooseFile = async () => loadFile(await pickFile('audio/*,video/*,.mp3,.wav,.m4a,.flac,.ogg,.opus,.aac,.mp4,.mov,.m4v,.mkv,.webm'));

  const onFileDropped = useEffectEvent((f) => loadFile({ path: registerFile(f), name: f.name }));
  useEffect(() => {
    if (!active) return;
    const onOver = (e) => { e.preventDefault(); setDropActive(true); };
    const onLeave = (e) => { if (!e.relatedTarget) setDropActive(false); };
    const onDrop = (e) => {
      e.preventDefault();
      setDropActive(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFileDropped(f);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [active]);

  const onLoadedMetadata = (e) => {
    const d = e.target.duration;
    if (!Number.isFinite(d)) return;
    setDuration(d); setStartTime(0); setEndTime(d);
  };

  const seek = (t) => {
    const p = player();
    if (p) p.currentTime = t;
    setPlayhead(t);
  };
  const seekWhileDragging = useEffectEvent((t) => seek(t));

  // Drag the START / END handles (mouse, pen or touch).
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (e) => {
      if (!spectrumRef.current) return;
      const rect = spectrumRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const t = (x / rect.width) * (duration || 1);
      if (dragging === 'start') { const v = Math.min(t, endTime - 0.1); setStartTime(v); seekWhileDragging(v); }
      else { const v = Math.max(t, startTime + 0.1); setEndTime(v); seekWhileDragging(v); }
    };
    const onUp = () => { setDragging(null); document.body.style.userSelect = prev; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = prev;
    };
  }, [dragging, startTime, endTime, duration]);

  const togglePlay = () => {
    const p = player();
    if (!p) return;
    if (isPlaying) { stopPlayback(); return; }
    // Resume from the playhead if it's inside the selection, else from START.
    const from = playhead > startTime && playhead < endTime - 0.05 ? playhead : startTime;
    p.currentTime = from;
    setPlayhead(from);
    p.play().catch(() => showToast('Your browser could not play this file.'));
    setIsPlaying(true);
    const tick = () => {
      if (!p || p.paused) { setIsPlaying(false); raf.current = null; return; }
      if (p.currentTime >= endTime) { p.pause(); setPlayhead(startTime); setIsPlaying(false); raf.current = null; return; }
      setPlayhead(p.currentTime);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const exportClip = async () => {
    if (!file || trimming) return;
    stopPlayback();
    setTrimming(true);
    setTrimMsg('');
    try {
      const { blob, name } = await trimFile(BASE, getFile(file.path), startTime, endTime);
      saveBlob(blob, name);
      setTrimMsg(`✨ Clip Exported! Saved “${name}” to your Downloads folder.`);
      showToast('Clip exported successfully!', 'success');
    } catch (e) {
      showToast(e.message || 'Trimming failed');
    } finally {
      setTrimming(false);
    }
  };

  const reset = () => { stopPlayback(); setFile(null); setUrl(''); setWaveData(null); setEndTime(0); setStartTime(0); setPlayhead(0); setTrimMsg(''); };
  const pct = (t) => `${(t / (duration || 1)) * 100}%`;

  return (
    <div className="tab-container">
      <div className="header-section">
        <h1>Clip <span className="gradient-text">Trimmer</span></h1>
        <p>Precision cut any audio or video file, right in your browser.</p>
      </div>

      <div className="glass-panel main-panel">
        {!file ? (
          <div className={`upload-zone ${dropActive ? 'drop-active' : ''}`} onClick={chooseFile}>
            <div className="upload-icon">📁</div>
            <h3>{dropActive ? 'Drop to open' : 'Drop a file here, or click to choose'}</h3>
            <p>Supports MP4, MP3, MOV, WAV, M4A and more. Your file stays on your computer.</p>
          </div>
        ) : (
          <div className="trimmer-workspace">
            <div className="trimmer-media-preview">
              {isAudio ? (
                <div className="audio-placeholder-pro">
                  <audio ref={audioRef} src={url} preload="auto" onLoadedMetadata={onLoadedMetadata} />
                  <div className="audio-viz-bars">
                    {[...Array(12)].map((_, i) => <div key={i} className="viz-bar"></div>)}
                  </div>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  src={url}
                  playsInline
                  onTimeUpdate={(e) => { if (!isPlaying) setPlayhead(e.target.currentTime); }}
                  onLoadedMetadata={onLoadedMetadata}
                  className="local-preview-player"
                  controls
                />
              )}
            </div>

            <div className="trimmer-info">
              <h3 className="video-title">{file.name}</h3>
              <div className="trim-actions-row">
                <div className="trim-primary-actions-full">
                  <button onClick={reset} className="btn-secondary-stylish" disabled={trimming}>Change File</button>
                  <button onClick={exportClip} className="export-trigger-btn-stylish" disabled={trimming || !duration}>
                    {trimming ? <div className="spinner-small"></div> : 'Export Trimmed Clip'}
                  </button>
                </div>
              </div>
            </div>

            <div className="trim-section-pro-wide">
              <div className="trim-header-studio">
                <div className="trim-time-display">
                  <span className={`playhead-time ${isPlaying ? 'live' : ''}`}>{formatPrecise(playhead)}</span>
                  <span className="time-divider">|</span>
                  <span className="selection-time">{formatDuration(startTime)} – {formatDuration(endTime)}</span>
                  <span className="selection-length">{formatPrecise(Math.max(0, endTime - startTime))} selected</span>
                </div>
                <button onClick={togglePlay} className="studio-play-btn" disabled={!duration}>
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
                  <TrimWaveform data={waveData} duration={duration || (waveData && waveData.duration) || 0} startTime={startTime} endTime={endTime} playhead={playhead} onSeek={seek} />
                  {waveLoading && <div className="waveform-loading">Analyzing audio…</div>}
                </div>
                <div className="range-container-studio">
                  <div className="selection-overlay" style={{ left: pct(startTime), width: pct(endTime - startTime) }}></div>
                  {duration > 0 && (
                    <div className={`playhead-marker ${isPlaying ? 'live' : ''}`} style={{ left: pct(playhead) }}>
                      <div className="playhead-bubble">{formatPrecise(playhead)}</div>
                    </div>
                  )}
                  <div className="handle-container" style={{ left: pct(startTime), touchAction: 'none' }} onPointerDown={(e) => { e.preventDefault(); setDragging('start'); }}>
                    <div className="handle-label top">START</div>
                    <div className="handle-bar"></div>
                    <div className="handle-label bottom">{formatDuration(startTime)}</div>
                  </div>
                  <div className="handle-container" style={{ left: pct(endTime), touchAction: 'none' }} onPointerDown={(e) => { e.preventDefault(); setDragging('end'); }}>
                    <div className="handle-label top">END</div>
                    <div className="handle-bar"></div>
                    <div className="handle-label bottom">{formatDuration(endTime)}</div>
                  </div>
                </div>
              </div>
            </div>

            {trimming && <div className="success-banner padded web-busy">Trimming in your browser… the first time also loads the video engine (about 30 MB).</div>}
            {trimMsg && <div className="success-banner padded">{trimMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
