import { useState, useEffect, useEffectEvent, useRef, useImperativeHandle } from 'react';

// Vocal Remover & Stem Splitter.
// The main process runs an AI model on the user's own computer and returns
// one MP3 per stem. Two modes: Fast (Demucs) and Best quality (BS-RoFormer). This tab plays the stems in
// sync (mute / solo per track) and saves single stems or a custom mix.
//
// Playback uses Web Audio: the stems (vocals, drums, bass, ... other) are
// decoded once and started on the same audio clock, so they can never drift.
// Mute / solo only fade each stem's gain. "Instrumental" is played as
// every non-vocal stem together.

const STEMS = {
  vocals: { label: 'Vocals', hint: 'Lead and backing vocals', color: '#f472b6' },
  instrumental: { label: 'Instrumental', hint: 'Everything except the vocals', color: '#22d3ee' },
  drums: { label: 'Drums', hint: 'Kick, snare and cymbals', color: '#fbbf24' },
  bass: { label: 'Bass', hint: 'Bass guitar and synth bass', color: '#34d399' },
  guitar: { label: 'Guitar', hint: 'Electric and acoustic guitar', color: '#fb923c' },
  piano: { label: 'Piano', hint: 'Piano and keys', color: '#60a5fa' },
  other: { label: 'Other Instruments', hint: 'Guitar, piano, synths, strings', color: '#a78bfa' },
};
// Display order. The model decides which of these exist (4 or 6 stems).
const ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const MODES = {
  fast: { label: 'Fast', time: 'About 1–3 minutes per song', note: 'Good separation, much quicker.' },
  best: { label: 'Best quality', time: 'About 3–7 minutes per song', note: 'Cleaner tracks with less bleed between instruments.' },
};
const stemHint = (id, ids) => (id === 'other' && ids.includes('guitar') ? 'Synths, strings and the rest' : STEMS[id].hint);
const MEDIA_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|mp4|mov|m4v|mkv|webm|avi)$/i;
const mediaUrl = (p) => `media://${p.split('/').map(encodeURIComponent).join('/')}`;

function fmt(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function StemIcon({ id }) {
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (id === 'vocals') return <svg {...p}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="17" x2="12" y2="22" /></svg>;
  if (id === 'drums') return <svg {...p}><ellipse cx="12" cy="8" rx="8" ry="3" /><path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8" /><line x1="15" y1="2" x2="19" y2="6" /></svg>;
  if (id === 'bass') return <svg {...p}><path d="M14 4l6 6" /><path d="M17 7l-7.5 7.5" /><circle cx="7" cy="17" r="4" /></svg>;
  if (id === 'guitar') return <svg {...p}><path d="M19 3l2 2-6 6" /><path d="M13.5 9.5a4 4 0 0 0-5.3.3L4 14a4 4 0 0 0 6 6l4.2-4.2a4 4 0 0 0 .3-5.3z" /><circle cx="9" cy="15" r="1.5" /></svg>;
  if (id === 'piano') return <svg {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M8 4v9M16 4v9M12 13v7M6 13h4M14 13h4" /></svg>;
  if (id === 'other') return <svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><line x1="7" y1="6" x2="7" y2="13" /><line x1="11" y1="6" x2="11" y2="13" /><line x1="15" y1="6" x2="15" y2="13" /></svg>;
  return <svg {...p}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
}

// Small waveform per stem: bars in the stem's colour, played part brighter.
function StemWave({ data, color, progress, dimmed, onSeek }) {
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2, maxH = mid - 3, step = 3;
    const bars = Math.max(1, Math.floor(width / step));
    const peaks = data && data.peaks;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(0, mid - 0.5, width, 1);
    for (let i = 0; i < bars; i++) {
      let pk = 0.03;
      if (peaks && peaks.length) {
        const a = Math.floor((i / bars) * peaks.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
        pk = 0;
        for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > pk) pk = peaks[k];
      }
      const h = Math.max(1, pk * maxH);
      const played = (i + 0.5) / bars <= progress;
      ctx.globalAlpha = dimmed ? 0.18 : played ? 1 : 0.45;
      ctx.fillStyle = color;
      ctx.fillRect(i * step, mid - h, 2, h * 2);
    }
    ctx.globalAlpha = 1;
  }, [data, color, progress, dimmed, width]);

  const handleDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  return <canvas ref={canvasRef} className="stem-wave" onMouseDown={handleDown} title="Click to jump here" />;
}

function StemSplitter({ ref, active, showToast }) {
  const [file, setFile] = useState(null);
  const [dropActive, setDropActive] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | separating | done
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('');
  const [stems, setStems] = useState(null); // { vocals: path, ... }
  const [waves, setWaves] = useState({});
  const [duration, setDuration] = useState(0);
  const [view, setView] = useState('vocal');
  const [muted, setMuted] = useState({});
  const [solo, setSolo] = useState([]); // soloed tracks (several allowed)
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mode, setMode] = useState('fast');
  const [usedMode, setUsedMode] = useState('fast');
  const [models, setModels] = useState(null); // download status of each AI model
  const [saving, setSaving] = useState(null);
  const [savedMsg, setSavedMsg] = useState('');
  const [audioReady, setAudioReady] = useState(false);
  const [sourceIds, setSourceIds] = useState([]); // stems the model returned, in display order
  const raf = useRef(null);
  const unsubscribe = useRef(null);
  const ctxRef = useRef(null);       // AudioContext
  const buffers = useRef({});        // decoded stems
  const gains = useRef({});          // one GainNode per stem
  const sources = useRef([]);        // currently playing buffer sources
  const clock = useRef({ startedAt: 0, offset: 0 });
  const loadId = useRef(0);

  const tracks = view === 'vocal' ? ['vocals', 'instrumental'] : sourceIds;
  const audible = (id) => (solo.length ? solo.includes(id) : !muted[id]);
  const baseName = file ? file.name.replace(/\.[^.]+$/, '') : '';

  const audioCtx = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return ctxRef.current;
  };

  const stopSources = () => {
    sources.current.forEach((src) => { try { src.onended = null; src.stop(); } catch { /* already stopped */ } });
    sources.current = [];
  };

  const currentTime = () => {
    const ctx = ctxRef.current;
    if (!ctx || !sources.current.length) return clock.current.offset;
    return Math.min(duration, ctx.currentTime - clock.current.startedAt);
  };

  const pause = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (sources.current.length) clock.current.offset = currentTime();
    stopSources();
    setPlaying(false);
  };

  // Lets App pause playback when the user switches tabs.
  useImperativeHandle(ref, () => ({ pause }));

  const reset = () => {
    pause();
    if (unsubscribe.current) unsubscribe.current();
    loadId.current += 1;
    buffers.current = {};
    clock.current = { startedAt: 0, offset: 0 };
    setAudioReady(false);
    setSourceIds([]);
    setFile(null); setStems(null); setWaves({}); setPhase('idle'); setPercent(0);
    setMuted({}); setSolo([]); setTime(0); setDuration(0); setSavedMsg('');
  };

  // Decode the four stems once, for gapless, sample-locked playback.
  const loadAudio = async (paths, ids) => {
    const id = ++loadId.current;
    const ctx = audioCtx();
    const decoded = await Promise.all(ids.map(async (s) => {
      let data;
      if (window.electron && window.electron.readStemFile) {
        const bytes = await window.electron.readStemFile(paths[s]);
        data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else {
        data = await (await fetch(mediaUrl(paths[s]))).arrayBuffer();
      }
      return [s, await ctx.decodeAudioData(data)];
    }));
    if (id !== loadId.current) return; // a newer song replaced this one
    buffers.current = Object.fromEntries(decoded);
    ids.forEach((s) => {
      if (!gains.current[s]) {
        const g = ctx.createGain();
        g.connect(ctx.destination);
        gains.current[s] = g;
      }
    });
    setAudioReady(true);
  };

  const loadFile = (f) => {
    if (!f || !f.path) return;
    if (!MEDIA_EXT.test(f.name)) {
      showToast('That file type is not supported. Use an audio or video file (MP3, WAV, M4A, MP4...).');
      return;
    }
    reset();
    setFile(f);
    refreshModels();
  };

  const refreshModels = async () => {
    if (window.electron && window.electron.getStemModels) setModels(await window.electron.getStemModels());
  };

  const chooseFile = async () => {
    if (!window.electron) return;
    const f = await window.electron.selectFile();
    if (f) loadFile(f);
  };

  const onFileDropped = useEffectEvent((f) => loadFile(f));

  useEffect(() => {
    if (!active) return;
    const onOver = (e) => { e.preventDefault(); setDropActive(true); };
    const onLeave = (e) => { if (!e.relatedTarget) setDropActive(false); };
    const onDrop = (e) => {
      e.preventDefault();
      setDropActive(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = window.electron && window.electron.getPathForFile ? window.electron.getPathForFile(f) : f.path;
      if (p) onFileDropped({ path: p, name: f.name });
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

  const separate = async () => {
    if (!file || !window.electron || !window.electron.separateStems) return;
    setPhase('separating');
    setPercent(0);
    setMessage('Getting ready...');
    unsubscribe.current = window.electron.onStemsProgress((p) => {
      setPercent(Math.round(p.percent || 0));
      if (p.message) setMessage(p.message);
    });
    const result = await window.electron.separateStems(file.path, mode);
    refreshModels();
    if (unsubscribe.current) unsubscribe.current();
    unsubscribe.current = null;
    if (!result || result.error || !result.stems) {
      setPhase('idle');
      if (!result || !result.cancelled) showToast((result && result.error) || 'Separation failed.');
      return;
    }
    const ids = ORDER.filter((s) => result.stems[s]);
    setStems(result.stems);
    setUsedMode(mode);
    setSourceIds(ids);
    setDuration(result.duration || 0);
    setPhase('done');
    loadAudio(result.stems, ids).catch(() => showToast('Could not load the separated tracks for playback.'));
    if (window.electron.getWaveform) {
      // Raw (un-normalised) levels, scaled together so a quiet stem looks quiet.
      const entries = (await Promise.all(Object.entries(result.stems).map(async ([id, p]) => [id, await window.electron.getWaveform(p, { raw: true })])))
        .filter(([, w]) => w && !w.error && w.peaks);
      const max = Math.max(1e-6, ...entries.map(([, w]) => Math.max(...w.peaks)));
      setWaves(Object.fromEntries(entries.map(([id, w]) => [id, { ...w, peaks: w.peaks.map((v) => v / max) }])));
    }
  };

  const cancel = () => {
    if (window.electron && window.electron.cancelStems) window.electron.cancelStems();
  };

  const startAt = (offset) => {
    const ctx = audioCtx();
    stopSources();
    const when = ctx.currentTime + 0.05; // same start time for every stem
    sources.current = sourceIds.map((s) => {
      const src = ctx.createBufferSource();
      src.buffer = buffers.current[s];
      src.connect(gains.current[s]);
      src.start(when, offset);
      return src;
    });
    clock.current = { startedAt: when - offset, offset };
    sources.current[0].onended = () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      sources.current = [];
      clock.current.offset = 0;
      setTime(0);
      setPlaying(false);
    };
    const tick = () => {
      setTime(Math.max(0, currentTime()));
      raf.current = requestAnimationFrame(tick);
    };
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  };

  const seekTo = (t) => {
    const to = Math.max(0, Math.min(t, duration - 0.05));
    if (playing) startAt(to);
    else clock.current.offset = to;
    setTime(to);
  };

  const togglePlay = async () => {
    if (playing) { pause(); return; }
    if (!audioReady) return;
    const ctx = audioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const from = clock.current.offset >= duration - 0.05 ? 0 : clock.current.offset;
    startAt(from);
    setPlaying(true);
  };

  const switchView = (next) => {
    if (next === view) return;
    setView(next);
    setMuted({});
    setSolo([]);
  };

  const toggleMute = (id) => { setSolo([]); setMuted((m) => ({ ...m, [id]: !m[id] })); };
  // Solo can be on for several tracks: you hear (and Save Mix saves) just those.
  const toggleSolo = (id) => setSolo((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Mute / solo: fade each stem's volume (no clicks, no re-syncing).
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !audioReady) return;
    const on = (id) => (solo.length ? solo.includes(id) : !muted[id]);
    sourceIds.forEach((s) => {
      const g = gains.current[s];
      if (!g) return;
      const track = view === 'vocal' && s !== 'vocals' ? 'instrumental' : s;
      g.gain.setTargetAtTime(on(track) ? 1 : 0, ctx.currentTime, 0.015);
    });
  }, [muted, solo, view, audioReady, sourceIds]);

  // Stop audio and free the audio engine when the tab is closed for good.
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    sources.current.forEach((src) => { try { src.stop(); } catch { /* already stopped */ } });
    if (ctxRef.current) ctxRef.current.close();
  }, []);

  const mixIds = tracks.filter(audible);
  const mixLabel = () => {
    if (!mixIds.length) return '';
    if (mixIds.length === tracks.length) return 'Full Mix';
    if (view === 'stems' && mixIds.length === tracks.length - 1 && !mixIds.includes('vocals')) return 'Instrumental';
    return mixIds.map((id) => STEMS[id].label.replace(' Instruments', '')).join(' + ');
  };

  const save = async (ids, label, key) => {
    if (!window.electron || !window.electron.exportStems || !ids.length || saving) return;
    setSaving(key);
    setSavedMsg('');
    const result = await window.electron.exportStems(ids.map((id) => stems[id]), baseName, label);
    setSaving(null);
    if (result && result.success) {
      setSavedMsg(`Saved “${result.name}” to your Downloads folder.`);
      showToast(`${label} saved to Downloads`, 'success');
    } else {
      showToast((result && result.error) || 'Saving failed.');
    }
  };

  const progress = duration ? time / duration : 0;

  return (
    <div className="tab-container">
      <div className="header-section">
        <h1>Vocal <span className="gradient-text">Remover</span></h1>
        <p>Remove vocals or split a song into drums, bass and instruments, then save the parts you want.</p>
      </div>

      <div className="glass-panel main-panel">
        {!file && (
          <div className={`upload-zone ${dropActive ? 'drop-active' : ''}`} onClick={chooseFile}>
            <div className="upload-icon">🎤</div>
            <h3>{dropActive ? 'Drop to open' : 'Drop a song here, or click to choose'}</h3>
            <p>MP3, WAV, M4A, FLAC, or a video file (MP4, MOV...)</p>
          </div>
        )}

        {file && phase !== 'done' && (
          <div className="stems-setup">
            <div className="stems-file-card">
              <div className="stems-file-icon"><StemIcon id="song" /></div>
              <div className="stems-file-info">
                <h3 className="video-title">{file.name}</h3>
                <p>We'll split it into <strong>vocals, drums, bass, guitar, piano</strong> and <strong>other instruments</strong>. Everything runs on your computer. Nothing is uploaded.</p>
              </div>
              {phase === 'idle' && <button className="btn-secondary-stylish" onClick={reset}>Change File</button>}
            </div>

            {phase === 'idle' && (
              <>
                <div className="stems-modes" role="radiogroup" aria-label="Separation quality">
                  {Object.entries(MODES).map(([id, m]) => {
                    const info = models && models[id];
                    return (
                      <button key={id} type="button" role="radio" aria-checked={mode === id} className={`stems-mode ${mode === id ? 'active' : ''}`} onClick={() => setMode(id)}>
                        <span className="stems-mode-top">
                          <span className="stems-mode-dot"></span>
                          <span className="stems-mode-name">{m.label}</span>
                          {info && (info.ready
                            ? <span className="stems-mode-badge ready">Ready</span>
                            : <span className="stems-mode-badge">One-time {info.sizeMB} MB download</span>)}
                        </span>
                        <span className="stems-mode-time">{m.time}</span>
                        <span className="stems-mode-note">{m.note}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="stems-start-row">
                  <span className="stems-note">Tracks are saved as MP3 (320 kbps).</span>
                  <button className="export-trigger-btn-stylish" onClick={separate}>Separate Tracks</button>
                </div>
              </>
            )}

            {phase === 'separating' && (
              <div className="progress-panel stems-progress">
                <div className="progress-header">
                  <span>{message}</span>
                  <span className="progress-pct">{percent}%</span>
                </div>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${percent}%` }}></div></div>
                <div className="stems-progress-actions">
                  <button className="stop-button-stylish" onClick={cancel}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {file && phase === 'done' && stems && (
          <div className="stems-workspace">
            <div className="stems-topbar">
              <div className="stems-title">
                <h3 className="video-title">{file.name}</h3>
                <span className="stems-time">{fmt(time)} / {fmt(duration)}</span>
                <span className="stems-used-mode">{MODES[usedMode].label}</span>
              </div>
              <div className="stems-view-toggle" role="tablist">
                <button className={view === 'vocal' ? 'active' : ''} onClick={() => switchView('vocal')}>Vocals / Instrumental</button>
                <button className={view === 'stems' ? 'active' : ''} onClick={() => switchView('stems')}>All Stems</button>
              </div>
            </div>

            <div className="stems-transport">
              <button className="studio-play-btn" onClick={togglePlay} disabled={!audioReady}>
                {!audioReady ? <div className="spinner-small"></div> : playing ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                )}
                {!audioReady ? 'Loading tracks…' : playing ? 'Pause' : 'Play'}
              </button>
              <p className="stems-hint"><strong>M</strong> mutes a track. <strong>S</strong> (solo) plays only the tracks you solo, so turn it on for several to hear them together. <strong>Save Mix</strong> saves exactly what you hear.</p>
            </div>

            <div className="stems-list">
              {tracks.map((id) => {
                const s = STEMS[id];
                const on = audible(id);
                return (
                  <div key={id} className={`stem-row ${on ? '' : 'off'}`} style={{ '--stem': s.color }}>
                    <div className="stem-meta">
                      <div className="stem-icon"><StemIcon id={id} /></div>
                      <div>
                        <div className="stem-name">{s.label}</div>
                        <div className="stem-hint">{stemHint(id, sourceIds)}</div>
                      </div>
                    </div>
                    <div className="stem-buttons">
                      <button className={`stem-btn ${muted[id] && !solo.length ? 'mute-on' : ''}`} onClick={() => toggleMute(id)} title="Mute (silence this track)">M</button>
                      <button className={`stem-btn ${solo.includes(id) ? 'solo-on' : ''}`} onClick={() => toggleSolo(id)} title="Solo (hear only soloed tracks; you can solo several)">S</button>
                    </div>
                    <div className="stem-wave-wrap">
                      <StemWave data={waves[id]} color={s.color} progress={progress} dimmed={!on} onSeek={(f) => seekTo(f * duration)} />
                      <div className="stem-playhead" style={{ left: `${progress * 100}%` }}></div>
                    </div>
                    <button className="stem-save" onClick={() => save([id], s.label, id)} disabled={!!saving}>
                      {saving === id ? <div className="spinner-small"></div> : (
                        <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>Save</>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="stems-footer">
              <span className="stems-note">Saved to Downloads as MP3 (320 kbps).</span>
              <div className="stems-footer-actions">
                <button className="btn-secondary-stylish" onClick={reset}>New Song</button>
                <button className="export-trigger-btn-stylish" onClick={() => save(mixIds, mixLabel(), 'mix')} disabled={!mixIds.length || !!saving}>
                  {saving === 'mix' ? <div className="spinner-small"></div> : 'Save Mix'}
                </button>
              </div>
            </div>
            {savedMsg && <div className="success-banner padded">✨ {savedMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default StemSplitter;
