# Horizon Music Player

A sleek, Neo-Brutalist desktop music player powered by Electron, featuring a custom YouTube Music proxy engine for ad-free streaming.

## Prerequisites

Before running the app, ensure you have the following installed on your system:
1. **Node.js & npm**: Required to run the Electron app.
2. **Bun**: Required for the high-performance local proxy server.
3. **yt-dlp**: Required for extracting high-quality audio streams. 
   *(Install via python: `pip install -U yt-dlp --break-system-packages`)*

## Installation

1. Navigate to the project directory:
   ```bash
   cd /path/to/Horizon
   ```

2. Install the necessary dependencies (Electron, yt-search, ytmusic-api, etc.):
   ```bash
   npm install
   # or using bun
   bun install
   ```

## Running the App

Starting the app is incredibly simple. The background proxy server (`youtube-proxy.js`) automatically launches alongside the Electron app.

To start the app, simply run:
```bash
npm start
```

## Features
- **Top Charts**: Automatically loads Billboard Top Hits on the home screen.
- **Global YouTube Search**: Searches standard YouTube, supporting official songs, AMVs, covers, and edits.
- **Custom Proxy Engine**: Bypasses ads and premium restrictions in real-time.
- **Neo-Brutalist UI**: Clean, high-contrast, responsive design.
- **Library Management**: Create playlists, edit names, delete playlists, and like songs.
- **Full Playback Controls**: Shuffle, Repeat (Loop), Next, Previous, and synchronized Lyrics.

## Troubleshooting

- **Proxy Error / Audio not loading**: Make sure `yt-dlp` is installed and accessible in your system's PATH. YouTube frequently changes its extraction logic, so keep `yt-dlp` updated: `pip install -U yt-dlp --break-system-packages`.
- **EADDRINUSE (Port 8000)**: The app runs a local proxy on port `8000`. Ensure no other application is using this port before starting the app.
# Horizon
# Horizon
# Horizon
