import { useState, useEffect, useRef } from 'react';

// Real waveform: mirrored bars whose height follows the audio's loudness
// (peak = outer bar, RMS = solid core), so loud, quiet and silent parts are
// easy to see. Selected range is coloured, the played part is brighter.
export default function TrimWaveform({ data, duration, startTime, endTime, playhead, onSeek }) {
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
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

    const mid = height / 2;
    const maxH = mid - 6;
    const barW = 2, gap = 1, step = barW + gap;
    const bars = Math.max(1, Math.floor(width / step));
    const dur = duration || 1;

    const sel = ctx.createLinearGradient(0, 0, 0, height);
    sel.addColorStop(0, '#8b5cf6'); sel.addColorStop(0.5, '#22d3ee'); sel.addColorStop(1, '#8b5cf6');
    const played = ctx.createLinearGradient(0, 0, 0, height);
    played.addColorStop(0, '#c4b5fd'); played.addColorStop(0.5, '#a5f3fc'); played.addColorStop(1, '#c4b5fd');

    // Centre line so silence reads as "flat"
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, mid - 0.5, width, 1);

    const peaks = data && data.peaks;
    const rms = data && data.rms;
    for (let i = 0; i < bars; i++) {
      const t = ((i + 0.5) / bars) * dur;
      let pk = 0.04, rm = 0.02; // placeholder while loading
      if (peaks && peaks.length) {
        const a = Math.floor((i / bars) * peaks.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
        pk = 0; rm = 0;
        for (let k = a; k < b && k < peaks.length; k++) { if (peaks[k] > pk) pk = peaks[k]; if (rms[k] > rm) rm = rms[k]; }
      }
      const inSel = t >= startTime && t <= endTime;
      const isPlayed = inSel && playhead != null && t <= playhead && playhead > startTime;
      const x = i * step;
      const hPeak = Math.max(1, pk * maxH);
      const hRms = Math.max(1, Math.min(hPeak, rm * maxH * 1.4));
      if (inSel) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = isPlayed ? played : sel;
        ctx.fillRect(x, mid - hPeak, barW, hPeak * 2);
        ctx.globalAlpha = 1;
        ctx.fillRect(x, mid - hRms, barW, hRms * 2);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.13)';
        ctx.fillRect(x, mid - hPeak, barW, hPeak * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x, mid - hRms, barW, hRms * 2);
      }
    }
    ctx.globalAlpha = 1;
  }, [data, duration, startTime, endTime, playhead, width]);

  const handleDown = (e) => {
    if (!onSeek || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    onSeek((x / rect.width) * duration);
  };

  return <canvas ref={canvasRef} className="waveform-canvas" onMouseDown={handleDown} title="Click to move the playhead" />;
}
