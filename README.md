# MusicKu Backend API

Backend untuk aplikasi MusicKu — YouTube search, streaming, dan download MP3.

## Deploy ke Railway

1. Push folder ini ke GitHub repo baru
2. Buka railway.app → New Project → Deploy from GitHub
3. Pilih repo ini
4. Railway otomatis detect nixpacks.toml dan install yt-dlp + ffmpeg
5. Copy URL Railway (contoh: musickku-backend.up.railway.app)

## Endpoints

| Method | URL | Keterangan |
|--------|-----|------------|
| GET | / | Health check |
| GET | /api/search?q=query | Search YouTube |
| GET | /api/info/:videoId | Info detail video |
| GET | /api/stream/:videoId | Stream audio (redirect) |
| POST | /api/download | Mulai download MP3 |
| GET | /api/download/progress/:jobId | Cek progress download |
| GET | /api/download/file/:jobId | Download file MP3 |

## Environment Variables

Tidak butuh env vars tambahan.
