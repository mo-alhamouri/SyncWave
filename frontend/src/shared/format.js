// Shared by the desktop app (App.jsx) and the website's web app (web/).

// Helper to format duration in seconds to MM:SS or HH:MM:SS
export function formatDuration(seconds) {
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

// Precise time for the playhead, e.g. 1:04.6
export function formatPrecise(seconds) {
  const t = Math.max(0, seconds || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export const MEDIA_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|mp4|mov|m4v|mkv|webm|avi)$/i;
export const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)$/i;
