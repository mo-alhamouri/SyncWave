// Browser version of SyncWave's separation engine (electron/stems-engine.js).
// The maths (STFT, Demucs/RoFormer runners, overlap-add) is the same as the
// desktop app; only reading and saving audio differ (Web Audio / ffmpeg.wasm).
// Keep the two in sync when changing either.
const SAMPLE_RATE = 44100;
const MODELS = {
    fast: {
        // Demucs: core network only; input = audio chunk + its spectrogram.
        sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
        chunk: 343980, // 7.8 s, the model's training length
        overlap: 0.25,
        normalizeSong: true,
    },
    best: {
        // BS-RoFormer: spectrogram in, masked spectrogram out.
        sources: ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'],
        chunk: 176400, // 4 s, fixed by the exported model
        overlap: 0.10, // ~17% less work than 0.25; checked by ear (v1.3.1)
        normalizeSong: false,
    },
};


// ---------------------------------------------------------------- FFT / STFT

const fftCache = new Map();
function getFFT(n) {
    if (fftCache.has(n)) return fftCache.get(n);
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
    // Periodic Hann window, like torch.hann_window(n).
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const f = {
        n, win,
        // In-place complex FFT. inverse=true computes the unscaled inverse.
        run(re, im, inverse) {
            for (let i = 0; i < n; i++) {
                const j = rev[i];
                if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
            }
            const sgn = inverse ? -1 : 1;
            for (let size = 2; size <= n; size <<= 1) {
                const half = size >> 1, step = n / size;
                for (let i = 0; i < n; i += size) {
                    for (let j = i, k = 0; j < i + half; j++, k += step) {
                        const l = j + half;
                        const c = cos[k], s = sgn * sin[k];
                        const tre = re[l] * c + im[l] * s;
                        const tim = im[l] * c - re[l] * s;
                        re[l] = re[j] - tre; im[l] = im[j] - tim;
                        re[j] += tre; im[j] += tim;
                    }
                }
            }
        },
    };
    fftCache.set(n, f);
    return f;
}

// torch's "reflect" padding (edge sample not repeated).
function reflectPad(x, left, right) {
    const L = x.length, out = new Float32Array(L + left + right);
    for (let i = 0; i < left; i++) out[i] = x[left - i];
    out.set(x, left);
    for (let k = 0; k < right; k++) out[left + L + k] = x[L - 2 - k];
    return out;
}

// torch.stft(x, n, hop, window=hann(n), center=True, pad_mode='reflect',
// onesided, normalized). Returns re/im laid out [freq][frame].
function stft(x, n, hop, normalized) {
    const f = getFFT(n);
    const padded = reflectPad(x, n / 2, n / 2);
    const T = 1 + Math.floor((padded.length - n) / hop), F = n / 2 + 1;
    const outRe = new Float32Array(F * T), outIm = new Float32Array(F * T);
    const re = new Float64Array(n), im = new Float64Array(n);
    const scale = normalized ? 1 / Math.sqrt(n) : 1;
    for (let t = 0; t < T; t++) {
        const off = t * hop;
        for (let i = 0; i < n; i++) { re[i] = padded[off + i] * f.win[i]; im[i] = 0; }
        f.run(re, im, false);
        for (let k = 0; k < F; k++) { outRe[k * T + t] = re[k] * scale; outIm[k * T + t] = im[k] * scale; }
    }
    return { re: outRe, im: outIm, F, T };
}

// torch.istft(z, n, hop, window=hann(n), center=True, normalized, length).
// re/im: [F = n/2+1][T], read through getRe(k, t) / getIm(k, t).
function istft(getRe, getIm, T, n, hop, normalized, length) {
    const f = getFFT(n), F = n / 2 + 1;
    const outLen = n + hop * (T - 1);
    const y = new Float64Array(outLen), env = new Float64Array(outLen);
    const re = new Float64Array(n), im = new Float64Array(n);
    const scale = (normalized ? Math.sqrt(n) : 1) / n;
    for (let t = 0; t < T; t++) {
        for (let k = 0; k < F; k++) { re[k] = getRe(k, t); im[k] = getIm(k, t); }
        im[0] = 0; im[F - 1] = 0;
        for (let k = 1; k < F - 1; k++) { re[n - k] = re[k]; im[n - k] = -im[k]; }
        f.run(re, im, true);
        const off = t * hop;
        for (let i = 0; i < n; i++) {
            y[off + i] += re[i] * scale * f.win[i];
            env[off + i] += f.win[i] * f.win[i];
        }
    }
    const out = new Float32Array(length), start = n / 2;
    for (let i = 0; i < length; i++) {
        const j = start + i;
        if (j >= outLen) break;
        out[i] = env[j] > 1e-11 ? y[j] / env[j] : 0;
    }
    return out;
}

// ------------------------------------------------------------ model runners

const DEMUCS = { n: 4096, hop: 1024 };

// Demucs' own spectrogram (HTDemucs._spec): extra reflect padding so the
// frame count is exactly length / hop; drops the top bin and 2 edge frames.
function demucsSpec(x) {
    const { n, hop } = DEMUCS;
    const L = x.length, le = Math.ceil(L / hop), pad = (hop / 2) * 3;
    const s = stft(reflectPad(x, pad, pad + le * hop - L), n, hop, true);
    const Fo = n / 2, re = new Float32Array(Fo * le), im = new Float32Array(Fo * le);
    for (let k = 0; k < Fo; k++) {
        for (let t = 0; t < le; t++) { re[k * le + t] = s.re[k * s.T + t + 2]; im[k * le + t] = s.im[k * s.T + t + 2]; }
    }
    return { re, im, le };
}

async function runDemucsChunk(ort, session, chunk) {
    const L = chunk[0].length, Fo = DEMUCS.n / 2;
    const specs = chunk.map(demucsSpec);
    const le = specs[0].le, plane = Fo * le;
    // "Complex as channels": [ch0 real, ch0 imag, ch1 real, ch1 imag].
    const mag = new Float32Array(4 * plane);
    specs.forEach((s, c) => { mag.set(s.re, (2 * c) * plane); mag.set(s.im, (2 * c + 1) * plane); });
    const mix = new Float32Array(2 * L);
    mix.set(chunk[0], 0); mix.set(chunk[1], L);
    const res = await session.run({
        mix: new ort.Tensor('float32', mix, [1, 2, L]),
        mag: new ort.Tensor('float32', mag, [1, 4, Fo, le]),
    });
    const spec = res.spec_out.data, time = res.time_out.data; // [1,S,4,Fo,le], [1,S,2,L]
    const S = res.time_out.dims[1];
    const { n, hop } = DEMUCS, pad = (hop / 2) * 3, Tfull = le + 4, total = le * hop + 2 * pad;
    const out = [];
    for (let s = 0; s < S; s++) {
        const chans = [];
        for (let c = 0; c < 2; c++) {
            const reBase = ((s * 4) + 2 * c) * plane, imBase = ((s * 4) + 2 * c + 1) * plane;
            // Re-add the dropped top bin and the 2 + 2 edge frames as zeros.
            const get = (base) => (k, t) => (k >= Fo || t < 2 || t >= le + 2 ? 0 : spec[base + k * le + (t - 2)]);
            const wav = istft(get(reBase), get(imBase), Tfull, n, hop, true, total);
            const ch = new Float32Array(L), tBase = (s * 2 + c) * L;
            for (let i = 0; i < L; i++) ch[i] = wav[pad + i] + time[tBase + i];
            chans.push(ch);
        }
        out.push(chans);
    }
    return out;
}

const ROFO = { n: 2048, hop: 512 };

async function runRoformerChunk(ort, session, chunk) {
    const L = chunk[0].length, { n, hop } = ROFO;
    const specs = chunk.map((x) => stft(x, n, hop, false));
    const { F, T } = specs[0], plane = F * T;
    const re = new Float32Array(2 * plane), im = new Float32Array(2 * plane);
    specs.forEach((s, c) => { re.set(s.re, c * plane); im.set(s.im, c * plane); });
    const res = await session.run({
        spec_real: new ort.Tensor('float32', re, [1, 2, F, T]),
        spec_imag: new ort.Tensor('float32', im, [1, 2, F, T]),
    });
    const oRe = res.out_spec_real.data, oIm = res.out_spec_imag.data; // [1,S,2,F,T]
    const S = res.out_spec_real.dims[1];
    const out = [];
    for (let s = 0; s < S; s++) {
        const chans = [];
        for (let c = 0; c < 2; c++) {
            const base = (s * 2 + c) * plane;
            chans.push(istft((k, t) => oRe[base + k * T + t], (k, t) => oIm[base + k * T + t], T, n, hop, false, L));
        }
        out.push(chans);
    }
    return out;
}


// Triangle weights for overlap-add between chunks.
function triangle(n) {
    const w = new Float32Array(n), half = Math.floor(n / 2);
    for (let i = 0; i < n; i++) w[i] = i <= half ? i + 1 : n - i;
    const max = half + 1;
    for (let i = 0; i < n; i++) w[i] /= max;
    return w;
}


// Separate already-decoded audio ([left, right] Float32Arrays at 44.1 kHz).
// onFirstChunk(chunk, out) is awaited after the first chunk (throw to stop),
// onChunk(k, total, ms) after every chunk.
export async function separate({ ort, session, mode, audio, onChunk, onFirstChunk }) {
    const cfg = MODELS[mode];
    const L = audio[0].length;
    audio = audio.map((c) => Float32Array.from(c));
    let mean = 0, std = 1;
    if (cfg.normalizeSong) {
        let s = 0, s2 = 0;
        for (let i = 0; i < L; i++) { const m = (audio[0][i] + audio[1][i]) / 2; s += m; s2 += m * m; }
        mean = s / L; std = Math.sqrt(Math.max(1e-12, (s2 - L * mean * mean) / Math.max(1, L - 1))) || 1;
        for (const ch of audio) for (let i = 0; i < L; i++) ch[i] = (ch[i] - mean) / std;
    }
    const seg = cfg.chunk, stride = Math.floor(seg * (1 - cfg.overlap)), w = triangle(seg);
    const S = cfg.sources.length;
    const acc = cfg.sources.map(() => [new Float32Array(L), new Float32Array(L)]);
    const sumW = new Float32Array(L);
    const offsets = [];
    for (let off = 0; off < L; off += stride) offsets.push(off);
    const run = mode === 'fast' ? runDemucsChunk : runRoformerChunk;
    for (let k = 0; k < offsets.length; k++) {
        const t0 = performance.now();
        const off = offsets[k], length = Math.min(seg, L - off), delta = seg - length;
        const start = off - Math.floor(delta / 2);
        const chunk = [new Float32Array(seg), new Float32Array(seg)];
        const cs = Math.max(0, start), ce = Math.min(L, start + seg);
        for (let c = 0; c < 2; c++) chunk[c].set(audio[c].subarray(cs, ce), cs - start);
        const out = await run(ort, session, chunk);
        if (k === 0 && onFirstChunk) await onFirstChunk(chunk, out);
        const from = Math.floor(delta / 2);
        for (let s = 0; s < S; s++) for (let c = 0; c < 2; c++) {
            const src = out[s][c], dst = acc[s][c];
            for (let i = 0; i < length; i++) dst[off + i] += src[from + i] * w[i];
        }
        for (let i = 0; i < length; i++) sumW[off + i] += w[i];
        if (onChunk) await onChunk(k + 1, offsets.length, performance.now() - t0);
    }
    for (let s = 0; s < S; s++) for (let c = 0; c < 2; c++) {
        const a = acc[s][c];
        for (let i = 0; i < L; i++) a[i] = (a[i] / (sumW[i] || 1)) * std + (cfg.normalizeSong ? mean : 0);
    }
    const stems = {};
    cfg.sources.forEach((n, s) => { stems[n] = acc[s]; });
    const inst = [new Float32Array(L), new Float32Array(L)];
    cfg.sources.forEach((n, s) => { if (n !== 'vocals') for (let c = 0; c < 2; c++) { const a = acc[s][c], d = inst[c]; for (let i = 0; i < L; i++) d[i] += a[i]; } });
    stems.instrumental = inst;
    return stems;
}
// How close b is to a, in dB (all channels). Used as a quick sanity check:
// the stems of a chunk should add back up to roughly the original sound.
export function snrDb(a, b) {
    let sig = 0, err = 0;
    for (let c = 0; c < a.length; c++) {
        const x = a[c], y = b[c];
        for (let i = 0; i < x.length; i++) {
            if (!Number.isFinite(y[i])) return -Infinity;
            const d = x[i] - y[i]; sig += x[i] * x[i]; err += d * d;
        }
    }
    return err === 0 ? Infinity : 10 * Math.log10((sig || 1e-20) / err);
}

export { MODELS, runDemucsChunk, runRoformerChunk, stft, istft, demucsSpec, SAMPLE_RATE };
