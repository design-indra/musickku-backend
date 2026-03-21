const express = require('express');
const { execSync, spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.set('trust proxy', 1);

const TMP_DIR = '/tmp/musickku';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Cleanup tmp setiap 30 menit
setInterval(() => {
  try {
    fs.readdirSync(TMP_DIR).forEach(f => {
      const fp = path.join(TMP_DIR, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > 20*60*1000) fs.unlinkSync(fp);
      } catch {}
    });
  } catch {}
}, 30*60*1000);

// ── HEALTH ────────────────────────────────────────────────
app.get('/', (req, res) => {
  const ytdlp = spawnSync('yt-dlp', ['--version']);
  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  res.json({
    status: 'ok', app: 'MusicKu Backend API', version: '2.0.0',
    ytdlp: ytdlp.status === 0 ? ytdlp.stdout.toString().trim() : 'NOT FOUND',
    ffmpeg: ffmpeg.status === 0 ? 'available' : 'NOT FOUND'
  });
});

// ── SEARCH ────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Query kosong' });
  try {
    const result = execSync(
      `yt-dlp "ytsearch${Math.min(parseInt(limit)||15, 20)}:${q.replace(/"/g,'')}" --dump-json --flat-playlist --no-warnings --no-check-certificates`,
      { maxBuffer: 20*1024*1024, timeout: 30000 }
    ).toString();
    const videos = result.trim().split('\n').map(line => {
      try {
        const v = JSON.parse(line);
        return {
          id: v.id, title: v.title,
          duration: v.duration || 0,
          durationStr: formatDuration(v.duration || 0),
          thumbnail: `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
          channel: v.uploader || v.channel || 'Unknown',
        };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ results: videos, total: videos.length });
  } catch (err) {
    res.status(500).json({ error: 'Gagal search: ' + err.message });
  }
});

// ── STREAM → MP3 pipe ────────────────────────────────────
app.get('/api/stream/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!isValidId(videoId)) return res.status(400).json({ error: 'ID tidak valid' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  console.log(`[STREAM] ${videoId}`);

  const ytdlp = spawn('yt-dlp', [
    '--no-warnings', '--no-check-certificates',
    '-f', 'bestaudio/best', '-o', '-',
    `https://youtube.com/watch?v=${videoId}`
  ], { stdio: ['ignore','pipe','pipe'] });

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 'mp3', '-acodec', 'libmp3lame',
    '-ab', '128k', '-ar', '44100', '-ac', '2',
    '-'
  ], { stdio: ['pipe','pipe','pipe'] });

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  ytdlp.stderr.on('data', () => {});
  ffmpeg.stderr.on('data', () => {});
  ytdlp.on('error', err => { if (!res.headersSent) res.status(500).end(); });
  ffmpeg.on('error', err => { if (!res.headersSent) res.status(500).end(); });

  const cleanup = () => { ytdlp.kill('SIGTERM'); ffmpeg.kill('SIGTERM'); };
  res.on('close', cleanup);
  req.on('aborted', cleanup);
});

// ── DOWNLOAD → MP3 file ──────────────────────────────────
const jobs = {};

app.post('/api/download', (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId || !isValidId(videoId)) return res.status(400).json({ error: 'videoId tidak valid' });

  const safeTitle = (title || videoId).replace(/[^\w\s\-]/g,'').trim().slice(0,80) || videoId;
  const jobId = `${videoId}_${Date.now()}`;
  const outTemplate = path.join(TMP_DIR, `${jobId}.%(ext)s`);

  jobs[jobId] = { status: 'downloading', percent: 0, title: safeTitle, videoId };
  console.log(`[DOWNLOAD] Start: ${safeTitle}`);

  const proc = spawn('yt-dlp', [
    '--no-warnings', '--no-check-certificates',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '-o', outTemplate,
    `https://youtube.com/watch?v=${videoId}`
  ]);

  let output = '';
  proc.stdout.on('data', d => {
    output += d.toString();
    const m = output.match(/(\d+\.?\d*)%/g);
    if (m) jobs[jobId].percent = parseFloat(m[m.length-1]);
  });
  proc.stderr.on('data', d => { output += d.toString(); });

  proc.on('close', code => {
    if (code === 0) {
      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(jobId));
      if (files.length > 0) {
        jobs[jobId] = { ...jobs[jobId], status: 'done', percent: 100, file: files[0] };
        console.log(`[DOWNLOAD] Done: ${files[0]}`);
      } else {
        jobs[jobId] = { ...jobs[jobId], status: 'error', message: 'File tidak ditemukan' };
      }
    } else {
      jobs[jobId] = { ...jobs[jobId], status: 'error', message: output.slice(-200) };
      console.error(`[DOWNLOAD] Failed (${code})`);
    }
    setTimeout(() => {
      try { if (jobs[jobId]?.file) fs.unlinkSync(path.join(TMP_DIR, jobs[jobId].file)); } catch {}
      delete jobs[jobId];
    }, 15*60*1000);
  });

  res.json({ jobId, message: 'Download dimulai' });
});

app.get('/api/download/progress/:jobId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json(job);
});

app.get('/api/download/file/:jobId', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'File belum siap' });
  const filePath = path.join(TMP_DIR, job.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File tidak ada' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((job.title||'lagu')+'.mp3')}`);
  res.setHeader('Content-Length', fs.statSync(filePath).size);
  res.sendFile(filePath);
});

// ── HELPERS ───────────────────────────────────────────────
function isValidId(id) { return /^[a-zA-Z0-9_-]{11}$/.test(id); }
function formatDuration(s) {
  if (!s) return '0:00';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60);
  if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`\n🎵 MusicKu Backend v2.0 — Port:${PORT}\n`);
});
