import { serve } from "bun";
import ytmusic from "ytmusic-api";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const api = new ytmusic();
await api.initialize();

// User Music Offline Directory Setup
const userMusicDir = path.join(os.homedir(), "Music", "Horizon");
if (!fs.existsSync(userMusicDir)) {
  fs.mkdirSync(userMusicDir, { recursive: true });
}
const manifestPath = path.join(userMusicDir, "downloads.json");

// In-memory audio stream cache with TTL
const streamCache = new Map(); // id -> { url, timestamp }
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

async function getStreamUrl(trackId, title = '', artist = '') {
  const cleanTitle = (title || "").replace(/[/\\?%*:|"<>]/g, '').trim();
  const cleanArtist = (artist || "").replace(/[/\\?%*:|"<>]/g, '').trim();
  let resolvedId = trackId;
  const isInvalidId = !resolvedId || resolvedId.length !== 11 || resolvedId.startsWith('tm_') || resolvedId.startsWith('fall_') || resolvedId.startsWith('track_');

  // Check cache first if we have a valid ID
  if (!isInvalidId) {
    const cached = streamCache.get(resolvedId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return cached.url;
    }

    try {
      const ytUrl = `https://www.youtube.com/watch?v=${resolvedId}`;
      const ytDlpCmd = `yt-dlp -g --extractor-args "youtube:client=android" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b" "${ytUrl}"`;
      const { stdout } = await execAsync(ytDlpCmd);
      const streamUrl = stdout.trim().split("\n")[0];
      if (streamUrl && streamUrl.startsWith("http")) {
        streamCache.set(resolvedId, { url: streamUrl, timestamp: Date.now() });
        return streamUrl;
      }
    } catch (err) {
      console.warn(`[STREAM] Direct ID ${resolvedId} unavailable, falling back to search:`, err.message);
    }
  }

  // Fallback: search YouTube for artist + title
  const query = `${cleanArtist} ${cleanTitle}`.trim() || 'popular music';
  try {
    const searchCmd = `yt-dlp -g --extractor-args "youtube:client=android" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b" "ytsearch1:${query.replace(/"/g, '')}"`;
    const { stdout } = await execAsync(searchCmd);
    const streamUrl = stdout.trim().split("\n")[0];
    if (streamUrl && streamUrl.startsWith("http")) {
      streamCache.set(resolvedId || trackId, { url: streamUrl, timestamp: Date.now() });
      return streamUrl;
    }
  } catch (searchErr) {
    console.warn("[STREAM] Fallback ytsearch failed:", searchErr.message);
  }

  // Secondary fallback: ytmusic API
  try {
    const searchRes = await api.search(query);
    const song = searchRes.find(r => (r.type === 'SONG' || r.type === 'VIDEO') && r.videoId);
    if (song && song.videoId && song.videoId !== resolvedId) {
      const ytDlpCmd = `yt-dlp -g --extractor-args "youtube:client=android" -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b" "https://www.youtube.com/watch?v=${song.videoId}"`;
      const { stdout } = await execAsync(ytDlpCmd);
      const streamUrl = stdout.trim().split("\n")[0];
      if (streamUrl && streamUrl.startsWith("http")) {
        streamCache.set(trackId, { url: streamUrl, timestamp: Date.now() });
        return streamUrl;
      }
    }
  } catch (apiErr) {
    console.warn("[STREAM] ytmusic-api search failed:", apiErr.message);
  }

  throw new Error(`Could not extract audio stream for ${cleanArtist} - ${cleanTitle}`);
}

serve({
  port: process.env.PORT || 8000,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS Headers
    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges"
    });

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    
    if (url.pathname === "/suggestions") {
      const query = url.searchParams.get("q");
      if (!query) return new Response("Missing query", { status: 400, headers });
      try {
        const suggestions = await api.getSearchSuggestions(query);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(suggestions), { headers });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers });
      }
    }

    
    if (url.pathname === "/playlist") {
      const pUrl = url.searchParams.get("url");
      if (!pUrl) return new Response("Missing url", { status: 400, headers });
      try {
        const { stdout } = await execAsync(`yt-dlp -J --flat-playlist "${pUrl}"`);
        const data = JSON.parse(stdout);
        const songs = (data.entries || []).map(v => ({
          id: v.id,
          title: v.title,
          artist: v.uploader || "Unknown Artist",
          image: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
        })).filter(v => v.title && v.title !== "[Private video]" && v.title !== "[Deleted video]");

        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(songs), { headers });
      } catch (err) {
        console.error("[PLAYLIST ERROR]", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

async function searchYouTubeWeb(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const html = await res.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    
    const sectionList = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const results = [];
    
    for (const section of sectionList) {
      const contents = section.itemSectionRenderer?.contents || [];
      for (const item of contents) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          const id = v.videoId;
          if (!id) continue;
          
          let rawTitle = v.title?.runs?.map(r => r.text).join("") || v.title?.simpleText || "Unknown Track";
          let rawArtist = v.ownerText?.runs?.map(r => r.text).join("") || v.shortBylineText?.runs?.map(r => r.text).join("") || "Unknown Artist";
          
          let title = rawTitle;
          let artist = rawArtist;
          
          if (title.includes(" - ")) {
            const parts = title.split(" - ");
            if (parts.length >= 2) {
              artist = parts[0].trim();
              title = parts.slice(1).join(" - ").trim();
            }
          }
          title = title.replace(/\s*[\(\[](Official\s*Music\s*Video|Official\s*Video|Official\s*Audio|Lyrics|Lyric\s*Video|Video|Audio|HD|HQ|4K|MV)[\)\]]/gi, "").trim();

          const thumb = v.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
          
          results.push({
            id,
            title,
            artist,
            image: thumb
          });
        }
      }
    }
    return results;
  } catch (err) {
    console.error("[YOUTUBE SEARCH ERROR]", err);
    return [];
  }
}

function extractArtist(song, fallback = "Unknown Artist") {
  let name = fallback;
  if (song.artist) {
    name = typeof song.artist === "string" ? song.artist : (song.artist.name || fallback);
  } else if (song.artists && song.artists.length > 0) {
    name = song.artists.map(a => a.name || a).join(", ");
  }
  if (!name || /^\d+:\d+$/.test(name.trim())) {
    return fallback;
  }
  return name;
}

    if (url.pathname === "/search") {
      const query = url.searchParams.get("q");
      if (!query) return new Response("Missing query", { status: 400, headers });

      try {
        const webResults = await searchYouTubeWeb(query);
        if (webResults.length > 0) {
          headers.set("Content-Type", "application/json");
          return new Response(JSON.stringify(webResults), { headers });
        }

        const results = await api.search(query);
        const songs = results
          .filter(r => (r.type === "SONG" || r.type === "VIDEO") && r.videoId)
          .map(song => {
            const artistName = extractArtist(song, "Unknown Artist");
            const image = (song.thumbnails && song.thumbnails.length > 0)
              ? song.thumbnails[song.thumbnails.length - 1].url
              : `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`;
            return {
              id: song.videoId,
              title: song.name || song.title || "Unknown Title",
              artist: artistName,
              image: image
            };
          });

        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(songs), { headers });
      } catch (err) {
        console.error("[SEARCH ERROR]", err);
        try {
          const { stdout } = await execAsync(`yt-dlp "ytsearch20:${query.replace(/"/g, '')}" --flat-playlist -J`);
          const data = JSON.parse(stdout);
          const songs = (data.entries || []).map(v => ({
            id: v.id,
            title: v.title,
            artist: v.uploader || "Unknown Artist",
            image: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`
          })).filter(v => v.id && v.title);
          headers.set("Content-Type", "application/json");
          return new Response(JSON.stringify(songs), { headers });
        } catch (fallbackErr) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
        }
      }
    }

    if (url.pathname === "/charts") {
      try {
        const webResults = await searchYouTubeWeb("Top Hits Billboard 2025");
        if (webResults.length > 0) {
          headers.set("Content-Type", "application/json");
          return new Response(JSON.stringify(webResults), { headers });
        }

        const results = await api.search("Top Hits Billboard");
        const songs = results.filter(r => r.type === "SONG" || r.type === "VIDEO").map(song => ({
          id: song.videoId,
          title: song.name,
          artist: extractArtist(song, "Unknown Artist"),
          image: song.thumbnails ? song.thumbnails[song.thumbnails.length - 1].url : "https://placehold.co/500x500/18181b/2bc5b4?text=🎵"
        }));

        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(songs), { headers });
      } catch (err) {
        console.error("[CHARTS ERROR]", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/artist") {
      const artistName = url.searchParams.get("q");
      if (!artistName) return new Response("Missing artist query", { status: 400, headers });

      try {
        const webResults = await searchYouTubeWeb(`${artistName} songs`);
        if (webResults.length > 0) {
          headers.set("Content-Type", "application/json");
          return new Response(JSON.stringify(webResults), { headers });
        }

        const results = await api.search(artistName);
        const songs = results
          .filter(r => (r.type === "SONG" || r.type === "VIDEO") && r.videoId)
          .slice(0, 25)
          .map(song => {
            const artistStr = extractArtist(song, artistName);
            const image = (song.thumbnails && song.thumbnails.length > 0)
              ? song.thumbnails[song.thumbnails.length - 1].url
              : `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`;
            return {
              id: song.videoId,
              title: song.name || song.title || "Unknown Title",
              artist: artistStr,
              image: image
            };
          });

        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(songs), { headers });
      } catch (err) {
        console.error("[ARTIST ERROR]", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/stream") {
      const trackId = url.searchParams.get("id");
      const title = url.searchParams.get("title") || "";
      const artist = url.searchParams.get("artist") || "";
      if (!trackId && !title) return new Response("Missing track ID", { status: 400, headers });

      // Fast-path: Check if downloaded locally in user offline songs
      if (trackId && fs.existsSync(manifestPath)) {
        try {
          const songs = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          const localTrack = Array.isArray(songs) ? songs.find(s => s.id === trackId) : null;
          if (localTrack && localTrack.offlinePath && fs.existsSync(localTrack.offlinePath)) {
            const redirectHeaders = new Headers(headers);
            redirectHeaders.set("Location", `/offline-stream?id=${encodeURIComponent(trackId)}`);
            return new Response(null, { status: 302, headers: redirectHeaders });
          }
        } catch(e) {}
      }

      try {
        let streamUrl;
        try {
          streamUrl = await getStreamUrl(trackId, title, artist);
        } catch (e) {
          streamCache.delete(trackId);
          streamUrl = await getStreamUrl(trackId, title, artist);
        }

        const fetchHeaders = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        };
        
        if (req.headers.has("range")) {
          fetchHeaders["Range"] = req.headers.get("range");
        }

        let audioResponse = await fetch(streamUrl, { headers: fetchHeaders });

        if (audioResponse.status === 403 || audioResponse.status === 410) {
          streamCache.delete(trackId);
          streamUrl = await getStreamUrl(trackId, title, artist);
          audioResponse = await fetch(streamUrl, { headers: fetchHeaders });
        }

        const newHeaders = new Headers(headers);
        newHeaders.set("Content-Type", audioResponse.headers.get("Content-Type") || "audio/webm");
        newHeaders.set("Accept-Ranges", "bytes");

        if (audioResponse.headers.has("content-range")) {
          newHeaders.set("Content-Range", audioResponse.headers.get("content-range"));
        }
        if (audioResponse.headers.has("content-length")) {
          newHeaders.set("Content-Length", audioResponse.headers.get("content-length"));
        }

        const buffer = await audioResponse.arrayBuffer();
        newHeaders.set("Content-Length", buffer.byteLength.toString());
        return new Response(buffer, { 
          status: audioResponse.status, 
          headers: newHeaders 
        });

      } catch (err) {
        console.error("[PROXY FATAL ERROR]:", err);
        return new Response(JSON.stringify({ error: "Streaming failed: " + err.message }), { status: 500, headers });
      }
    }

    // Offline Downloads API & Management
    if (url.pathname === "/api/downloads") {
      headers.set("Content-Type", "application/json");
      if (req.method === "GET") {
        try {
          if (!fs.existsSync(manifestPath)) {
            return new Response(JSON.stringify([]), { headers });
          }
          const data = fs.readFileSync(manifestPath, "utf8");
          let songs = JSON.parse(data);
          if (!Array.isArray(songs)) songs = [];
          
          // Verify file presence & ensure streamUrl points to offline-stream
          const verified = songs.filter(s => {
            const fPath = s.offlinePath || (s.filename ? path.join(userMusicDir, s.filename) : null);
            return fPath && fs.existsSync(fPath);
          }).map(s => ({
            ...s,
            isDownloaded: true,
            streamUrl: `http://localhost:8000/offline-stream?id=${s.id}`
          }));

          return new Response(JSON.stringify(verified), { headers });
        } catch (e) {
          console.error("[API DOWNLOADS ERROR]:", e);
          return new Response(JSON.stringify([]), { headers });
        }
      }

      if (req.method === "POST") {
        try {
          const body = await req.json();
          const songs = Array.isArray(body) ? body : (body.songs || []);
          fs.writeFileSync(manifestPath, JSON.stringify(songs, null, 2));
          return new Response(JSON.stringify({ success: true, count: songs.length }), { headers });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
        }
      }
    }

    if (url.pathname === "/api/downloads/delete" && req.method === "POST") {
      headers.set("Content-Type", "application/json");
      try {
        const body = await req.json();
        const targetId = body.id;
        if (!targetId) return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers });

        let songs = [];
        if (fs.existsSync(manifestPath)) {
          songs = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (!Array.isArray(songs)) songs = [];
        }

        const target = songs.find(s => s.id === targetId);
        if (target) {
          const fPath = target.offlinePath || (target.filename ? path.join(userMusicDir, target.filename) : null);
          if (fPath && fs.existsSync(fPath)) {
            try { fs.unlinkSync(fPath); } catch (err) { console.warn("Could not delete file:", err); }
          }
        }

        // Also check if any file in userMusicDir matches targetId
        const files = fs.readdirSync(userMusicDir);
        for (const file of files) {
          if (file.includes(targetId) || (target && target.title && file.includes(target.title.replace(/[^a-zA-Z0-9 -]/g, '')))) {
            try { fs.unlinkSync(path.join(userMusicDir, file)); } catch (e) {}
          }
        }

        songs = songs.filter(s => s.id !== targetId);
        fs.writeFileSync(manifestPath, JSON.stringify(songs, null, 2));
        return new Response(JSON.stringify({ success: true, downloads: songs }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/offline-stream") {
      const trackId = url.searchParams.get("id");
      const filename = url.searchParams.get("file");

      let targetFilePath = null;
      if (filename) {
        const p = path.join(userMusicDir, filename);
        if (fs.existsSync(p)) targetFilePath = p;
      }

      if (!targetFilePath && trackId && fs.existsSync(manifestPath)) {
        try {
          const songs = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          const found = songs.find(s => s.id === trackId);
          if (found && found.offlinePath && fs.existsSync(found.offlinePath)) {
            targetFilePath = found.offlinePath;
          }
        } catch (e) {}
      }

      if (!targetFilePath && trackId) {
        const files = fs.readdirSync(userMusicDir);
        const match = files.find(f => f.includes(trackId));
        if (match) targetFilePath = path.join(userMusicDir, match);
      }

      if (!targetFilePath || !fs.existsSync(targetFilePath)) {
        return new Response("Offline audio file not found", { status: 404, headers });
      }

      const stat = fs.statSync(targetFilePath);
      const total = stat.size;
      const range = req.headers.get("range");
      const ext = path.extname(targetFilePath).toLowerCase();
      const contentType = ext === ".m4a" ? "audio/mp4" : "audio/webm";

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunkSize = (end - start) + 1;
        const fileStream = fs.createReadStream(targetFilePath, { start, end });

        const rangeHeaders = new Headers(headers);
        rangeHeaders.set("Content-Range", `bytes ${start}-${end}/${total}`);
        rangeHeaders.set("Accept-Ranges", "bytes");
        rangeHeaders.set("Content-Length", chunkSize.toString());
        rangeHeaders.set("Content-Type", contentType);

        return new Response(fileStream, { status: 206, headers: rangeHeaders });
      } else {
        const fullHeaders = new Headers(headers);
        fullHeaders.set("Content-Length", total.toString());
        fullHeaders.set("Content-Type", contentType);
        fullHeaders.set("Accept-Ranges", "bytes");

        return new Response(fs.createReadStream(targetFilePath), { status: 200, headers: fullHeaders });
      }
    }

    if (url.pathname === "/download") {
      const trackId = url.searchParams.get("id") || "";
      const title = url.searchParams.get("title") || "Track";
      const artist = url.searchParams.get("artist") || "Unknown Artist";
      const image = url.searchParams.get("image") || "";
      const saveOffline = url.searchParams.get("saveOffline") === "true";

      if (!trackId && !title) {
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify({ error: "Missing track ID or title" }), { status: 400, headers });
      }

      const cleanTitle = (title || "Track").replace(/[/\\?%*:|"<>]/g, '').trim() || "Track";
      const cleanArtist = (artist || "Unknown").replace(/[/\\?%*:|"<>]/g, '').trim() || "Artist";
      const baseOutput = path.join(userMusicDir, `${cleanArtist} - ${cleanTitle}`);
      const outputTemplate = `${baseOutput}.%(ext)s`;

      try {
        let downloadedFile = null;

        // 1. Check if already present on disk
        if (fs.existsSync(`${baseOutput}.webm`)) {
          downloadedFile = `${baseOutput}.webm`;
        } else if (fs.existsSync(`${baseOutput}.m4a`)) {
          downloadedFile = `${baseOutput}.m4a`;
        }

        // 2. Download directly to disk via yt-dlp if not present
        if (!downloadedFile) {
          let downloadSuccess = false;
          const isRealId = trackId && trackId.length === 11 && !trackId.startsWith('tm_') && !trackId.startsWith('fall_') && !trackId.startsWith('track_');
          
          if (isRealId) {
            try {
              const dlCmd = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b" --no-playlist -o "${outputTemplate}" "https://www.youtube.com/watch?v=${trackId}"`;
              await execAsync(dlCmd);
              downloadSuccess = true;
            } catch (dlErr) {
              console.warn(`[DOWNLOAD] Direct download for ${trackId} failed, falling back to search:`, dlErr.message);
            }
          }

          if (!downloadSuccess) {
            const query = `${cleanArtist} ${cleanTitle}`.trim() || 'music';
            const dlFallbackCmd = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b" --no-playlist -o "${outputTemplate}" "ytsearch1:${query.replace(/"/g, '')}"`;
            await execAsync(dlFallbackCmd);
          }

          // Locate newly saved file
          if (fs.existsSync(`${baseOutput}.webm`)) {
            downloadedFile = `${baseOutput}.webm`;
          } else if (fs.existsSync(`${baseOutput}.m4a`)) {
            downloadedFile = `${baseOutput}.m4a`;
          } else {
            const files = fs.readdirSync(userMusicDir);
            const found = files.find(f => f.startsWith(`${cleanArtist} - ${cleanTitle}`));
            if (found) {
              downloadedFile = path.join(userMusicDir, found);
            }
          }
        }

        if (!downloadedFile || !fs.existsSync(downloadedFile)) {
          throw new Error("Could not locate downloaded file on disk");
        }

        const actualFilename = path.basename(downloadedFile);
        const resolvedTrackId = trackId || ('song_' + Date.now());

        // Update downloads manifest
        let existingSongs = [];
        if (fs.existsSync(manifestPath)) {
          try { existingSongs = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch(e) {}
          if (!Array.isArray(existingSongs)) existingSongs = [];
        }

        existingSongs = existingSongs.filter(s => s.id !== resolvedTrackId && s.filename !== actualFilename);
        const offlineItem = {
          id: resolvedTrackId,
          title,
          artist,
          image,
          filename: actualFilename,
          offlinePath: downloadedFile,
          streamUrl: `http://localhost:8000/offline-stream?id=${encodeURIComponent(resolvedTrackId)}`,
          isDownloaded: true
        };
        existingSongs.push(offlineItem);
        fs.writeFileSync(manifestPath, JSON.stringify(existingSongs, null, 2));

        if (saveOffline) {
          headers.set("Content-Type", "application/json");
          return new Response(JSON.stringify({ success: true, track: offlineItem }), { headers });
        }

        // Return file as attachment for regular download requests
        const ext = path.extname(downloadedFile).toLowerCase();
        const contentType = ext === ".m4a" ? "audio/mp4" : "audio/webm";
        const stat = fs.statSync(downloadedFile);
        const dlHeaders = new Headers(headers);
        dlHeaders.set("Content-Type", contentType);
        dlHeaders.set("Content-Disposition", `attachment; filename="${actualFilename}"`);
        dlHeaders.set("Content-Length", stat.size.toString());
        return new Response(fs.createReadStream(downloadedFile), { headers: dlHeaders });

      } catch (err) {
        console.error("[DOWNLOAD FATAL ERROR]:", err);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify({ error: err.message || "Download failed" }), { status: 500, headers });
      }
    }

    return new Response("YouTube Music Proxy Engine Online", { headers });
  }
});
console.log("YouTube Proxy listening on http://localhost:8000");
