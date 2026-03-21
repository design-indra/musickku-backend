const express = require('express');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS & MIDDLEWARE ─────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Penting: Railway pakai proxy
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({ windowMs: 60*1000, max: 60, message: { error: 'Terlalu banyak request, coba lagi nanti.' } });
app.use('/api/', limiter);

// Temp dir untuk download
const TMP_DIR = path.join('/tmp', 'musickku');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'MusicKu Backend API',
    version: '1.0.0',
    endpoints: ['/api/search', '/api/info/:id', '/api/stream/:id', '/api/download/:id']
  });
});

// ── SEARCH YOUTUBE ────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 15, 20);
  if (!query) return res.status(400).json({ error: 'Query kosong' });

  try {
    const result = execSync(
      `yt-dlp "ytsearch${limit}:${query.replace(/"/g, '')}" --dump-json --flat-playlist --no-warnings --no-check-certificates`,
      { maxBuffer: 15 * 1024 * 1024, timeout: 30000 }
    ).toString();

    const videos = result.trim().split('\n')
      .map(line => {
        try {
          const v = JSON.parse(line);
          return {
            id: v.id,
            title: v.title,
            duration: v.duration || 0,
            durationStr: formatDuration(v.duration || 0),
            thumbnail: `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
            thumbnailHQ: `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
            channel: v.uploader || v.channel || 'Unknown',
            viewCount: v.view_count || 0,
            url: `https://youtube.com/watch?v=${v.id}`
          };
        } catch { return null; }
      })
      .filter(Boolean);

    res.json({ results: videos, query, total: videos.length });
  } catch (err) {
    res.status(500).json({ error: 'Gagal search: ' + err.message });
  }
});

// ── INFO VIDEO ────────────────────────────────────────────
app.get('/api/info/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID tidak valid' });

  try {
    const result = execSync(
      `yt-dlp --dump-json --no-warnings --no-check-certificates "https://youtube.com/watch?v=${videoId}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 20000 }
    ).toString();

    const v = JSON.parse(result);
    res.json({
      id: v.id,
      title: v.title,
      artist: v.artist || v.uploader || v.channel || 'Unknown',
      album: v.album || '',
      duration: v.duration || 0,
      durationStr: formatDuration(v.duration || 0),
      thumbnail: `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
      thumbnailHQ: `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
      channel: v.uploader || v.channel || 'Unknown',
      description: (v.description || '').slice(0, 200),
      uploadDate: v.upload_date || '',
      viewCount: v.view_count || 0,
      likeCount: v.like_count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal ambil info: ' + err.message });
  }
});

// ── STREAM AUDIO ─────────────────────────────────────────
app.get('/api/stream/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID tidak valid' });

  try {
    // Coba format yang didukung Chrome Android: webm opus > mp4 aac > best
    const audioUrl = execSync(
      `yt-dlp -f "bestaudio[ext=webm]/bestaudio[ext=mp4]/bestaudio/best" --get-url --no-warnings --no-check-certificates "https://youtube.com/watch?v=${videoId}"`,
      { timeout: 25000 }
    ).toString().trim().split('\n')[0];

    if (!audioUrl) return res.status(404).json({ error: 'URL tidak ditemukan' });

    const https = require('https');
    const http = require('http');
    const urlObj = new URL(audioUrl);
    const client = urlObj.protocol === 'https:' ? https : http;

    const rangeHeader = req.headers.range || '';

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Mobile Safari/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
        ...(rangeHeader && { 'Range': rangeHeader })
      }
    };

    const proxyReq = client.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || 'audio/webm';
      
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      };
      
      if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];

      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream error: ' + err.message });
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();

  } catch (err) {
    res.status(500).json({ error: 'Gagal stream: ' + err.message });
  }
});

// ── DOWNLOAD MP3 ─────────────────────────────────────────
const downloadJobs = {};

app.post('/api/download', (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId || !isValidVideoId(videoId)) return res.status(400).json({ error: 'videoId tidak valid' });

  const safeTitle = (title || videoId).replace(/[^\w\s\-]/g, '').trim().slice(0, 80);
  const jobId = `${videoId}_${Date.now()}`;
  const outPath = path.join(TMP_DIR, `${jobId}.%(ext)s`);

  downloadJobs[jobId] = { status: 'downloading', percent: 0, title: safeTitle, videoId };

  const proc = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '--embed-thumbnail',
    '--add-metadata',
    '-o', outPath,
    '--no-warnings',
    '--no-check-certificates',
    `https://youtube.com/watch?v=${videoId}`
  ]);

  let output = '';
  proc.stdout.on('data', d => {
    output += d.toString();
    const match = output.match(/(\d+\.?\d*)%/);
    if (match) downloadJobs[jobId].percent = parseFloat(match[1]);
  });
  proc.stderr.on('data', d => { output += d.toString(); });

  proc.on('close', code => {
    if (code === 0) {
      // Find output file
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId));
      if (files.length) {
        downloadJobs[jobId] = { status: 'done', percent: 100, title: safeTitle, file: files[0], videoId };
      } else {
        downloadJobs[jobId] = { status: 'error', percent: 0, message: 'File tidak ditemukan' };
      }
    } else {
      downloadJobs[jobId] = { status: 'error', percent: 0, message: output.slice(-200) };
    }
    // Auto-cleanup setelah 10 menit
    setTimeout(() => {
      const job = downloadJobs[jobId];
      if (job && job.file) {
        try { fs.unlinkSync(path.join(TMP_DIR, job.file)); } catch {}
      }
      delete downloadJobs[jobId];
    }, 600000);
  });

  res.json({ jobId, message: 'Download dimulai' });
});

app.get('/api/download/progress/:jobId', (req, res) => {
  const job = downloadJobs[req.params.jobId];
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json(job);
});

app.get('/api/download/file/:jobId', (req, res) => {
  const job = downloadJobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File belum siap' });

  const filePath = path.join(TMP_DIR, job.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ada' });

  const safeFilename = encodeURIComponent(job.title + '.mp3');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(filePath);
});

// ── HELPERS ───────────────────────────────────────────────
function isValidVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════╗`);
  console.log(`║  🎵 MusicKu Backend v1.0.0        ║`);
  console.log(`║  Port: ${PORT}                       ║`);
  console.log(`╚═══════════════════════════════════╝\n`);
});
