# Horizon Music Player

A sleek, Neo-Brutalist desktop music player powered by Electron and a high-performance local **Go (Golang)** proxy engine.

## Prerequisites

1. **Node.js & npm** (Node 18+)
2. **Go** (1.20+)
3. **yt-dlp** (installed in `~/.local/bin/yt-dlp`)

## Quick Start

1. **Install Node dependencies:**
   ```bash
   npm install
   ```

2. **Build and Run:**
   ```bash
   npm start
   ```

> [!NOTE]
> `npm start` automatically compiles and starts the native Go backend daemon (`./horizon-backend`) alongside Electron. When you close the app, the backend process is cleanly terminated.

## Features
- **Zero-Dependency Native Backend**: Single compiled Go binary replacing Python and virtual environments.
- **Top Charts**: Automatically loads trending hits on the home screen.
- **Global Search**: Search any video, creator, official song, remix, cover, or album.
- **Direct Stream Extraction**: Real-time direct stream extraction using `yt-dlp`.
- **In-Memory Caching**: Ultra-fast search and stream playback with Go mutex-protected caches.
- **Offline Downloads**: Download songs locally to `~/Music/Horizon/` for offline listening.
- **Neo-Brutalist UI**: Clean high-contrast theme, responsive layout, and playback controls.
