const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');

let YTDlpWrap = require('yt-dlp-wrap');
if (YTDlpWrap.default) {
    YTDlpWrap = YTDlpWrap.default;
}

const app = express();
const PORT = process.env.PORT || 5001;

// Middlewares
app.use(cors());
app.use(express.json());

// Serve static files from the frontend build directory
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
    console.log(`Serving static files from: ${frontendDistPath}`);
    app.use(express.static(frontendDistPath));
    
    // Handle SPA routing
    app.get(/^\/(?!api).*/, (req, res) => {
        res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
}

// Directories setup
const downloadsDir = path.join(__dirname, 'downloads');
const binDir = path.join(__dirname, 'bin');
const ytDlpPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

const https = require('https');

// Helper to download standalone yt-dlp binary from GitHub
function downloadStandaloneYtdlp(dest) {
    return new Promise((resolve, reject) => {
        let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        if (process.platform === 'darwin') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
        } else if (process.platform === 'win32') {
            downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
        }

        console.log(`Downloading standalone yt-dlp binary for platform '${process.platform}' from: ${downloadUrl}`);

        const file = fs.createWriteStream(dest);
        const download = (url) => {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    download(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download binary: HTTP ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        resolve();
                    });
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        };
        download(downloadUrl);
    });
}

// Global ytDlpWrap instance variable
let ytDlpWrap = null;

// Initialize and download yt-dlp binary
async function initYtdlp() {
    try {
        console.log(`FFmpeg binary found at: ${ffmpeg.path}`);
        
        if (!fs.existsSync(ytDlpPath)) {
            await downloadStandaloneYtdlp(ytDlpPath);
            console.log('Standalone yt-dlp binary downloaded successfully!');
        } else {
            console.log('yt-dlp binary already exists. Ready to use.');
        }

        // Set executable permissions on unix systems
        if (process.platform !== 'win32') {
            fs.chmodSync(ytDlpPath, '755');
        }

        ytDlpWrap = new YTDlpWrap(ytDlpPath);
        
        // Output version to confirm it works
        const version = await ytDlpWrap.getVersion();
        console.log(`yt-dlp initialized. Version: ${version.trim()}`);
    } catch (error) {
        console.error('Failed to initialize yt-dlp:', error);
        process.exit(1);
    }
}


// Extract video info endpoint
app.get('/api/info', async (req, res) => {
    const videoUrl = req.query.url;
    console.log(`[GET] /api/info?url=${videoUrl}`);
    
    if (!videoUrl) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    if (!ytDlpWrap) {
        return res.status(503).json({ error: 'YouTube Downloader service is initializing' });
    }

    let targetUrl = videoUrl.trim();
    
    // Automatically rewrite hybrid watch+list URLs to pure playlist URLs
    // This handles the common scenario where users copy links while watching a video inside a playlist
    if (targetUrl.includes('list=')) {
        try {
            const urlObj = new URL(targetUrl);
            const playlistId = urlObj.searchParams.get('list');
            if (playlistId) {
                targetUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
                console.log(`Rewrote Watch+List URL to pure Playlist URL: ${targetUrl}`);
            }
        } catch (e) {
            const match = targetUrl.match(/[&?]list=([^&]+)/);
            if (match && match[1]) {
                targetUrl = `https://www.youtube.com/playlist?list=${match[1]}`;
                console.log(`Regex-rewrote URL to pure Playlist URL: ${targetUrl}`);
            }
        }
    }

    try {
        console.log(`Fetching metadata for: ${targetUrl}`);
        
        // Fetch flat metadata first to check if the URL points to a playlist
        // This is extremely fast and avoids downloading massive formats/details up front
        // We use --dump-single-json to ensure we get a single JSON object even for playlists
        // Note: Some versions of yt-dlp-wrap might return an array if it fails to parse as a single object
        const flatMetadata = await ytDlpWrap.getVideoInfo([targetUrl, '--flat-playlist', '--dump-single-json']);
        
        let isPlaylist = false;
        let entries = [];
        let playlistTitle = 'Untitled Playlist';
        let playlistId = '';
        let channel = 'Unknown Channel';

        if (Array.isArray(flatMetadata)) {
            // Some extractors return an array of entries directly
            if (flatMetadata.length > 0) {
                // Filter out entries that might be the playlist itself or other non-video types
                // Videos usually have _type 'url' or no _type but have an 'id' and 'title'
                const filtered = flatMetadata.filter(e => e && e.id && (e._type === 'url' || !e._type) && e.id !== e.playlist_id);
                
                if (filtered.length > 0 || flatMetadata.some(e => e.playlist_id)) {
                    isPlaylist = true;
                    entries = filtered;
                    const first = flatMetadata.find(e => e.playlist_title || e.playlist || e.playlist_id) || flatMetadata[0];
                    playlistTitle = first.playlist_title || first.playlist || playlistTitle;
                    playlistId = first.playlist_id || playlistId;
                    channel = first.playlist_uploader || first.playlist_channel || channel;
                }
            }
        } else if (flatMetadata && (flatMetadata._type === 'playlist' || Array.isArray(flatMetadata.entries))) {
            isPlaylist = true;
            // Filter entries within the playlist object
            const rawEntries = Array.isArray(flatMetadata.entries) ? flatMetadata.entries : [];
            entries = rawEntries.filter(e => e && e.id && (e._type === 'url' || !e._type));
            
            playlistTitle = flatMetadata.title || playlistTitle;
            playlistId = flatMetadata.id || playlistId;
            channel = flatMetadata.uploader || flatMetadata.channel || channel;
        }

        if (isPlaylist) {
            console.log(`Detected playlist: "${playlistTitle}" [${playlistId}] containing ${entries.length} valid video items`);

            const responseData = {
                isPlaylist: true,
                id: playlistId,
                title: playlistTitle,
                channel: channel,
                videoCount: entries.length,
                entries: entries.map((e, index) => ({
                    index: index + 1,
                    id: e.id,
                    title: e.title || 'Untitled Video',
                    duration: e.duration || 0,
                    url: `https://www.youtube.com/watch?v=${e.id}`
                }))
            };
            return res.json(responseData);
        }

        // If it's not a playlist, fetch full metadata (including streams, formats, sizes)
        const metadata = await ytDlpWrap.getVideoInfo(videoUrl);
        
        // Structure only what the client needs to keep payloads lightweight
        const responseData = {
            isPlaylist: false,
            id: metadata.id,
            title: metadata.title,
            thumbnail: metadata.thumbnail || (metadata.thumbnails && metadata.thumbnails.length ? metadata.thumbnails[metadata.thumbnails.length - 1].url : null),
            duration: metadata.duration, // in seconds
            viewCount: metadata.view_count,
            channel: metadata.channel,
            description: metadata.description ? metadata.description.slice(0, 200) + '...' : '',
            formats: metadata.formats ? metadata.formats.map(f => ({
                formatId: f.format_id,
                extension: f.ext,
                resolution: f.resolution || `${f.width}x${f.height}`,
                filesize: f.filesize || f.filesize_approx,
                fps: f.fps
            })) : []
        };
        
        res.json(responseData);
    } catch (error) {
        console.error('Error fetching video info:', error);
        res.status(500).json({ error: error.message || 'Failed to extract video information. Check if the URL is valid.' });
    }
});


// SSE Download endpoint
app.get('/api/download', async (req, res) => {
    const { url, format } = req.query;
    if (!url || !format) {
        return res.status(400).json({ error: 'Both URL and format (mp3/mp4) are required' });
    }

    if (!ytDlpWrap) {
        return res.status(503).json({ error: 'YouTube Downloader service is initializing' });
    }

    const fileId = uuidv4();
    const fileExtension = format === 'mp3' ? 'mp3' : 'mp4';
    const outputPath = path.join(downloadsDir, `${fileId}.%(ext)s`);
    const finalPath = path.join(downloadsDir, `${fileId}.${fileExtension}`);

    // Set up Server-Sent Events headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Prevent Nginx buffer compression
    });

    // Helper to send SSE events
    const sendSSE = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({ status: 'started', message: 'Initializing download process...' });

    let ytDlpArgs = [];
    if (format === 'mp3') {
        ytDlpArgs = [
            url,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0', // Highest quality VBR
            '--ffmpeg-location', ffmpeg.path,
            '-o', outputPath
        ];
    } else {
        ytDlpArgs = [
            url,
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '--ffmpeg-location', ffmpeg.path,
            '-o', outputPath
        ];
    }

    console.log(`Starting yt-dlp download: ${ytDlpArgs.join(' ')}`);

    let ytDlpEventEmitter = ytDlpWrap.exec(ytDlpArgs);
    let lastPercent = 0;

    ytDlpEventEmitter.on('progress', (progress) => {
        // Only send updates if the percentage has changed to reduce SSE traffic
        if (Math.floor(progress.percent) !== Math.floor(lastPercent)) {
            lastPercent = progress.percent;
        }
        sendSSE({
            status: 'downloading',
            percent: progress.percent,
            speed: progress.currentSpeed,
            eta: progress.eta,
            totalSize: progress.totalSize
        });
    });

    ytDlpEventEmitter.on('ytDlpEvent', (event, data) => {
        console.log(`yt-dlp [${event}]: ${data}`);
        if (data.includes('Extracting audio') || data.includes('Destination:')) {
            sendSSE({ status: 'processing', message: 'Converting and extracting audio streams...' });
        } else if (data.includes('Merging formats')) {
            sendSSE({ status: 'processing', message: 'Merging video and audio streams...' });
        }
    });

    ytDlpEventEmitter.on('close', () => {
        console.log(`Finished downloading/converting: ${fileId}.${fileExtension}`);
        
        // Double-check file exists on disk
        if (fs.existsSync(finalPath)) {
            sendSSE({
                status: 'completed',
                fileId: fileId,
                ext: fileExtension,
                message: 'Conversion completed! Starting download...'
            });
        } else {
            console.error(`Expected file not found at: ${finalPath}`);
            // Check if there's any file matching the fileId
            const files = fs.readdirSync(downloadsDir);
            const foundFile = files.find(f => f.startsWith(fileId));
            if (foundFile) {
                const foundExt = path.extname(foundFile).replace('.', '');
                sendSSE({
                    status: 'completed',
                    fileId: fileId,
                    ext: foundExt,
                    message: 'Conversion completed! Starting download...'
                });
            } else {
                sendSSE({ status: 'error', error: 'File was processed but could not be located on disk.' });
            }
        }
        res.end();
    });

    ytDlpEventEmitter.on('error', (err) => {
        console.error('yt-dlp download error:', err);
        sendSSE({ status: 'error', error: err.message || 'Error occurred during download/conversion.' });
        res.end();
    });

    // If client closes connection prematurely, terminate child process
    req.on('close', () => {
        if (ytDlpEventEmitter && ytDlpEventEmitter.ytDlpProcess) {
            console.log(`Client disconnected. Killing yt-dlp process for task: ${fileId}`);
            ytDlpEventEmitter.ytDlpProcess.kill('SIGTERM');
        }
    });
});

// Download finalized file endpoint
app.get('/api/files/:id', (req, res) => {
    const fileId = req.params.id;
    const ext = req.query.ext || 'mp3';
    const rawTitle = req.query.title || 'youtube-download';
    
    const filePath = path.join(downloadsDir, `${fileId}.${ext}`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Download file not found or has expired.' });
    }

    // Sanitize title for content disposition header
    const cleanTitle = rawTitle.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
    
    console.log(`Serving file download: ${cleanTitle}`);
    res.download(filePath, cleanTitle, (err) => {
        if (err) {
            console.error('Error during file transfer:', err);
        }
    });
});

// Auto-cleanup downloaded files older than 30 minutes
setInterval(() => {
    console.log('Running storage auto-cleanup...');
    fs.readdir(downloadsDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                // Delete files older than 30 minutes
                if (now - stats.mtimeMs > 30 * 60 * 1000) {
                    fs.unlink(filePath, (err) => {
                        if (!err) console.log(`Auto-cleaned temp file: ${file}`);
                    });
                }
            });
        });
    });
}, 5 * 60 * 1000); // Every 5 minutes

// Start Server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
    await initYtdlp(); // Trigger standalone download
});
