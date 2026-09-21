// Initialize Lucide icons
try { lucide.createIcons(); } catch(e) { console.warn("Lucide icons failed to load:", e); }
// Splash screen intro (5 seconds)



// Environment / Node.js Bridges
let fsNode, pathNode, osNode, httpNode;
try {
    fsNode = typeof require !== 'undefined' ? require('fs') : null;
    pathNode = typeof require !== 'undefined' ? require('path') : null;
    osNode = typeof require !== 'undefined' ? require('os') : null;
    httpNode = typeof require !== 'undefined' ? require('http') : null;
} catch(e) {
    console.warn("Node modules not directly available (web/mobile mode)");
}

// Download Directory & Manifest Setup
let downloadsDir = '';
let downloadsManifestFile = '';
try {
    if (pathNode && osNode) {
        downloadsDir = pathNode.join(osNode.homedir(), 'Music', 'Horizon');
        if (true) {
            fsNode.mkdirSync(downloadsDir, { recursive: true });
        }
        downloadsManifestFile = pathNode.join(downloadsDir, 'downloads.json');
    }
} catch(e) {
    console.warn("Could not create local Music/Horizon folder:", e);
}

// Dual Cache: Memory + In-App LocalStorage + Local File + Backend Proxy
let downloadsMemoryCache = null;
let playlists = JSON.parse(localStorage.getItem('playlists') || '[]');
let recentlyPlayed = JSON.parse(localStorage.getItem('recently_played') || '[]');

if (!playlists.some(p => p.id === 'liked')) {
    playlists.unshift({ id: 'liked', name: 'Liked Songs', songs: [] });
    try {
        localStorage.setItem('playlists', JSON.stringify(playlists));
    } catch(e) {}
}

async function syncOfflineDownloadsWithBackend() {
    try {
        const res = await fetch(`${PROXY_URL}/api/downloads`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
                downloadsMemoryCache = data;
                localStorage.setItem('horizon_downloads_cache', JSON.stringify(data));
                updateLibraryBadges();
                if (currentViewPlaylistId === 'downloads') {
                    renderPlaylistDetails('downloads');
                }
            }
        }
    } catch(e) {
        console.warn("Backend proxy downloads sync offline:", e);
    }
}

function getDownloadedSongs() {
    if (downloadsMemoryCache !== null && Array.isArray(downloadsMemoryCache)) {
        return downloadsMemoryCache;
    }
    
    let songs = [];
    
    // 1. Try reading from filesystem manifest in Electron
    try {
        if (true) {
            const fileData = fsNode.readFileSync(downloadsManifestFile, 'utf8');
            const parsed = JSON.parse(fileData);
            if (Array.isArray(parsed) && parsed.length > 0) {
                songs = parsed;
            }
        }
    } catch(e) {
        console.warn("Could not read downloads.json from disk:", e);
    }
    
    // 2. Fallback to in-app localStorage cache (persists in browser)
    if (!songs || songs.length === 0) {
        try {
            const cached = localStorage.getItem('horizon_downloads_cache');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    songs = parsed;
                }
            }
        } catch(e) {
            console.warn("Could not read localStorage downloads cache:", e);
        }
    }
    
    if (!Array.isArray(songs)) songs = [];
    downloadsMemoryCache = songs;
    return songs;
}

function saveDownloadManifest(songs) {
    if (!Array.isArray(songs)) songs = [];
    downloadsMemoryCache = [...songs];
    
    // 1. Save to in-app localStorage cache
    try {
        localStorage.setItem('horizon_downloads_cache', JSON.stringify(songs));
    } catch(e) {
        console.warn("Could not save to localStorage downloads cache:", e);
    }
    
    // 2. Save to filesystem downloads.json if in Electron
    try {
        if (fsNode && downloadsManifestFile) {
            if (downloadsDir && !fsNode.existsSync(downloadsDir)) {
                fsNode.mkdirSync(downloadsDir, { recursive: true });
            }
            fsNode.writeFileSync(downloadsManifestFile, JSON.stringify(songs, null, 2));
        }
    } catch(e) {
        console.warn("Could not write downloads.json to disk:", e);
    }

    // 3. Sync to backend proxy
    try {
        fetch(`${PROXY_URL}/api/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(songs)
        }).catch(() => {});
    } catch(e) {}
    
    updateLibraryBadges();
}

// Elements & Screens
const homeScreen = document.getElementById('home-screen');
const nowPlayingScreen = document.getElementById('now-playing-screen');
const miniPlayer = document.getElementById('mini-player');
const audio = document.getElementById('audioPlayer');

// State
// --- API CONFIGURATION ---
// Set this to your deployed public URL when shipping the APK
const ENV = 'prod'; // Change to 'prod'
const PROXY_URL = ENV === 'prod' ? 'https://horizon-youtube-proxy.onrender.com' : 'http://localhost:8000';
let queue = [];
let currentIndex = -1;
let isPlaying = false;
let hasPlayed = false;
let isRepeat = false;
let isShuffle = false;
let isMuted = false;
let previousVolume = 1;
let parsedLyrics = [];
let isScrubbing = false;

// Curated Fallback Tracks
const FALLBACK_TRACKS = [
    {
        id: "hTWKbfoikeg",
        title: "Smells Like Teen Spirit",
        artist: "Nirvana",
        image: "https://picsum.photos/seed/nirvana/300/300",
        streamUrl: ""
    },
    {
        id: "TO-_3tck2tg",
        title: "Bones",
        artist: "Imagine Dragons",
        image: "https://picsum.photos/seed/bones/300/300",
        streamUrl: ""
    },
    {
        id: "_Yhyp-_hX2s",
        title: "Lose Yourself",
        artist: "Eminem",
        image: "https://picsum.photos/seed/eminem_rap/300/300",
        streamUrl: ""
    },
    {
        id: "pb-EwykPTv8",
        title: "Ghosts 'n' Stuff",
        artist: "deadmau5",
        image: "https://picsum.photos/seed/deadmau5/300/300",
        streamUrl: ""
    }
];

// Screen Toggling
function toggleScreens() {
    nowPlayingScreen.classList.toggle('active');
    
    if (nowPlayingScreen.classList.contains('active')) {
        miniPlayer.style.display = 'none';
    } else {
        if (hasPlayed) {
            miniPlayer.style.display = 'flex';
        }
    }
}

// Toast Notifications
let toastTimeout;
function showToast(msg) {
    const banner = document.getElementById('toastBanner');
    if (!banner) return;
    banner.textContent = msg;
    banner.style.display = 'block';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        banner.style.display = 'none';
    }, 2800);
}

// ==========================================================================
// HOME SCREEN DATA & LOGIC (Musify Spec Section 1)
// ==========================================================================

const SUGGESTED_PLAYLISTS = [
    {
        id: 'sug_today_top_hits',
        title: "Today's Top Hits",
        badge: 'PLAYLIST',
        image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=500&auto=format&fit=crop&q=80',
        query: 'Top Hits Billboard'
    },
    {
        id: 'sug_lofi_chill',
        title: 'Chill Lofi Beats',
        badge: 'ALBUM',
        image: 'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=500&auto=format&fit=crop&q=80',
        query: 'Lofi hip hop beats to relax'
    },
    {
        id: 'sug_rock_classics',
        title: 'Rock Classics',
        badge: 'PLAYLIST',
        image: 'https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=500&auto=format&fit=crop&q=80',
        query: 'Classic Rock Hits'
    },
    {
        id: 'sug_synthwave',
        title: 'Synthwave Neon',
        badge: 'ALBUM',
        image: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=500&auto=format&fit=crop&q=80',
        query: 'Synthwave retro electro'
    },
    {
        id: 'sug_deep_focus',
        title: 'Deep Focus Ambient',
        badge: 'PLAYLIST',
        image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&auto=format&fit=crop&q=80',
        query: 'Ambient electronic study'
    }
];

const TIME_MACHINE_TOP_TRACKS = [
    {
        id: "hTWKbfoikeg",
        title: "Smells Like Teen Spirit",
        artist: "Nirvana",
        image: "https://picsum.photos/seed/nirvana/300/300",
        streamUrl: "",
        plays: 48
    },
    {
        id: "TO-_3tck2tg",
        title: "Bones",
        artist: "Imagine Dragons",
        image: "https://picsum.photos/seed/bones/300/300",
        streamUrl: "",
        plays: 42
    },
    {
        id: "_Yhyp-_hX2s",
        title: "Lose Yourself",
        artist: "Eminem",
        image: "https://picsum.photos/seed/eminem_rap/300/300",
        streamUrl: "",
        plays: 35
    },
    {
        id: "pb-EwykPTv8",
        title: "Ghosts 'n' Stuff",
        artist: "deadmau5",
        image: "https://picsum.photos/seed/deadmau5/300/300",
        streamUrl: "",
        plays: 29
    },
    {
        id: "K0HSD_i2DvA",
        title: "Around the World",
        artist: "Daft Punk",
        image: "https://picsum.photos/seed/daftpunk/300/300",
        streamUrl: "",
        plays: 24
    }
];

const RADIO_STATIONS = [
    {
        id: "radio_lofi",
        title: "Lofi Hip Hop Radio",
        artist: "ChillHop Live 24/7",
        image: "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=300&auto=format&fit=crop&q=80",
        streamUrl: "https://actions.google.com/sounds/v1/transportation/subway_interior_movement.ogg"
    },
    {
        id: "radio_synth",
        title: "Nightwave Synthwave FM",
        artist: "Retro Wave Live",
        image: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=300&auto=format&fit=crop&q=80",
        streamUrl: "https://actions.google.com/sounds/v1/science_fiction/force_field.ogg"
    },
    {
        id: "radio_jazz",
        title: "Coffee Shop Jazz Radio",
        artist: "Acoustic & Soft Jazz",
        image: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&auto=format&fit=crop&q=80",
        streamUrl: "https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg"
    },
    {
        id: "radio_rock",
        title: "Classic Rock Revival",
        artist: "70s & 80s Live Hits",
        image: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=300&auto=format&fit=crop&q=80",
        streamUrl: "https://actions.google.com/sounds/v1/sports/roller_coaster.ogg"
    }
];

let recommendedTracks = [];
// --- Real Listening Time Tracking ---
let totalListenedSeconds = 0;
try {
    const stored = localStorage.getItem('musify_listened_seconds');
    if (stored !== null) {
        const val = parseInt(stored, 10);
        // Clean migration: 74880 was the old mock placeholder (~1,248 mins)
        if (val >= 74880 && val < 76500) {
            totalListenedSeconds = Math.max(0, val - 74880);
        } else if (!isNaN(val) && val >= 0) {
            totalListenedSeconds = val;
        }
    }
    localStorage.setItem('musify_listened_seconds', totalListenedSeconds);
} catch(e) {}

let currentCustomTracks = [];
let listeningStorageTimer = null;

function saveListeningSeconds() {
    try {
        localStorage.setItem('musify_listened_seconds', totalListenedSeconds);
    } catch(e) {}
}

function recordListeningProgress(sec = 1) {
    if (sec <= 0) return;
    totalListenedSeconds += sec;
    if (!listeningStorageTimer) {
        listeningStorageTimer = setTimeout(() => {
            saveListeningSeconds();
            listeningStorageTimer = null;
        }, 3000);
    }
    updateListeningStatsDisplay();
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', saveListeningSeconds);
    window.addEventListener('pagehide', saveListeningSeconds);
}

function updateListeningStatsDisplay() {
    const mins = Math.floor(totalListenedSeconds / 60);
    const tmDisplay = document.getElementById('tmMinutesDisplay');
    if (tmDisplay) {
        if (totalListenedSeconds > 0 && totalListenedSeconds < 60) {
            tmDisplay.textContent = '< 1 min';
        } else {
            tmDisplay.textContent = `${mins.toLocaleString()} min${mins === 1 ? '' : 's'}`;
        }
    }
    const modalMinutes = document.getElementById('statsModalMinutes');
    if (modalMinutes) {
        modalMinutes.textContent = (totalListenedSeconds > 0 && mins === 0) ? '< 1' : mins.toLocaleString();
    }
    const dailyAvg = document.getElementById('statsDailyAvg');
    if (dailyAvg) {
        if (mins === 0 && totalListenedSeconds > 0) {
            dailyAvg.textContent = '< 1 min';
        } else {
            dailyAvg.textContent = `${Math.round(mins / 30)} mins`;
        }
    }
    const playedEl = document.getElementById('statsTracksPlayed');
    if (playedEl) {
        playedEl.textContent = (Array.isArray(recentlyPlayed) ? recentlyPlayed.length : 0).toString();
    }
    
    // Dynamic top artist from actual playback history
    const topArtistEl = document.getElementById('statsTopArtist');
    if (topArtistEl && Array.isArray(recentlyPlayed) && recentlyPlayed.length > 0) {
        const artistCounts = {};
        recentlyPlayed.forEach(s => {
            if (s && s.artist) {
                artistCounts[s.artist] = (artistCounts[s.artist] || 0) + 1;
            }
        });
        const top = Object.entries(artistCounts).sort((a, b) => b[1] - a[1])[0];
        if (top) topArtistEl.textContent = top[0];
    }
}

function renderSuggestedPlaylists() {
    const container = document.getElementById('suggestedPlaylistsContainer');
    if (!container) return;
    container.innerHTML = '';
    
    SUGGESTED_PLAYLISTS.forEach(pl => {
        const card = document.createElement('div');
        card.className = 'suggested-card';
        card.style.backgroundImage = `url('${pl.image}')`;
        card.onclick = () => openSuggestedPlaylist(pl.id);
        
        card.innerHTML = `
            <div class="suggested-card-overlay">
                <span class="suggested-badge ${pl.badge.toLowerCase()}">${pl.badge}</span>
                <h3 class="suggested-title">${pl.title}</h3>
            </div>
        `;
        container.appendChild(card);
    });
}

async function openSuggestedPlaylist(id) {
    const pl = SUGGESTED_PLAYLISTS.find(p => p.id === id);
    if (!pl) return;
    showToast(`Loading ${pl.title}...`);
    try {
        const res = await fetch(`${PROXY_URL}/search?q=${encodeURIComponent(pl.query)}`);
        if (res.ok) {
            const data = await res.json();
            const tracks = Array.isArray(data) ? data : (data.results || []);
            if (tracks.length > 0) {
                currentCustomTracks = tracks.map(t => ({
                    id: t.id || ('track_' + Math.random().toString(36).substr(2, 9)),
                    title: t.title || 'Unknown Track',
                    artist: t.artist || 'Unknown Artist',
                    image: t.image || 'https://picsum.photos/300/300',
                    streamUrl: `${PROXY_URL}/stream?id=${t.id}`
                }));
                openPlaylistDetails('custom_suggested_' + id);
                return;
            }
        }
    } catch(e) {}
    currentCustomTracks = FALLBACK_TRACKS;
    openPlaylistDetails('custom_suggested_' + id);
}

// Real Play Tracking & Dynamic Time Machine Logic
function recordSongPlay(song) {
    if (!song || !song.id) return;
    try {
        let counts = JSON.parse(localStorage.getItem('musify_play_counts') || '{}');
        const songId = song.id;
        if (!counts[songId]) {
            counts[songId] = {
                count: 1,
                song: {
                    id: song.id,
                    title: song.title || 'Unknown Track',
                    artist: song.artist || 'Unknown Artist',
                    image: song.image || 'https://picsum.photos/300/300',
                    streamUrl: song.streamUrl || ''
                },
                lastPlayed: Date.now()
            };
        } else {
            counts[songId].count += 1;
            counts[songId].lastPlayed = Date.now();
            if (song.title) counts[songId].song.title = song.title;
            if (song.artist) counts[songId].song.artist = song.artist;
            if (song.image) counts[songId].song.image = song.image;
        }
        localStorage.setItem('musify_play_counts', JSON.stringify(counts));
    } catch(e) {}
}

function getCompletedPlays(songId) {
    if (!songId) return 0;
    try {
        const counts = JSON.parse(localStorage.getItem('musify_completed_plays') || '{}');
        return counts[songId] || 0;
    } catch(e) {
        return 0;
    }
}

function recordCompletedPlay(song) {
    if (!song || !song.id) return;
    try {
        const counts = JSON.parse(localStorage.getItem('musify_completed_plays') || '{}');
        counts[song.id] = (counts[song.id] || 0) + 1;
        localStorage.setItem('musify_completed_plays', JSON.stringify(counts));
    } catch(e) {}
}

function getUserTopTracks() {
    try {
        const counts = JSON.parse(localStorage.getItem('musify_play_counts') || '{}');
        const sorted = Object.values(counts)
            .sort((a, b) => (b.count - a.count) || (b.lastPlayed - a.lastPlayed))
            .map(item => ({
                ...item.song,
                plays: item.count
            }));
        return sorted;
    } catch(e) {
        return [];
    }
}

let timeMachineTracks = [];

function getTimeMachineTracks() {
    const result = [];
    const usedIds = new Set();

    // 1. Show user's recently played tracks first in Time Machine
    if (Array.isArray(recentlyPlayed)) {
        for (const track of recentlyPlayed) {
            if (track && track.id && !usedIds.has(track.id)) {
                usedIds.add(track.id);
                result.push({
                    ...track,
                    plays: getCompletedPlays(track.id)
                });
                if (result.length >= 5) break;
            }
        }
    }

    // 2. Supplement with real live chart songs from YouTube if fewer than 5
    if (result.length < 5 && Array.isArray(recommendedTracks) && recommendedTracks.length > 0) {
        for (let i = 0; i < recommendedTracks.length; i++) {
            const chartSong = recommendedTracks[i];
            if (chartSong && chartSong.id && !usedIds.has(chartSong.id)) {
                usedIds.add(chartSong.id);
                result.push({
                    ...chartSong,
                    plays: getCompletedPlays(chartSong.id)
                });
                if (result.length >= 5) break;
            }
        }
    }

    // 3. Fallback to default tracks if charts not yet ready and still fewer than 5
    if (result.length < 5 && typeof TIME_MACHINE_TOP_TRACKS !== 'undefined') {
        for (const t of TIME_MACHINE_TOP_TRACKS) {
            if (t && t.id && !usedIds.has(t.id)) {
                usedIds.add(t.id);
                result.push({
                    ...t,
                    plays: getCompletedPlays(t.id)
                });
                if (result.length >= 5) break;
            }
        }
    }

    timeMachineTracks = result.slice(0, 5);
    return timeMachineTracks;
}

function renderTimeMachine() {
    const listEl = document.getElementById('timeMachineList');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    const tracks = getTimeMachineTracks();

    // Update pill dynamically to real current month/year
    const pill = document.getElementById('tmSourceDatePill');
    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    if (pill) {
        pill.textContent = `Recently Played • ${monthYear}`;
    }
    
    tracks.forEach((track, idx) => {
        const row = document.createElement('div');
        row.className = 'tm-song-item';
        row.setAttribute('data-track-id', track.id);
        row.onclick = (e) => {
            if (e.target.closest('.menu-dots-btn')) return;
            playTimeMachineTrack(idx);
        };
        
        const fullPlays = (track.plays !== undefined && track.plays !== null) ? track.plays : 0;
        
        row.innerHTML = `
            <span class="tm-rank">${idx + 1}</span>
            <div class="tm-cover" style="background-image: url('${track.image || "https://picsum.photos/300/300"}');"></div>
            <div class="tm-info">
                <h4>${track.title || 'Unknown Track'}</h4>
                <p>${track.artist || 'Unknown Artist'}</p>
            </div>
            <div class="tm-plays-badge" title="${fullPlays} full plays">
                <i data-lucide="headphones"></i>
                <span>${fullPlays}</span>
            </div>
            <button class="menu-dots-btn" title="Options" onclick="event.stopPropagation(); event.preventDefault(); openSongActionMenu(timeMachineTracks[${idx}], this)">
                <i data-lucide="more-vertical"></i>
            </button>
        `;
        listEl.appendChild(row);
    });
    
    updateListeningStatsDisplay();
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: listEl });
    }
}

function playTimeMachineTrack(idx) {
    queue = [...timeMachineTracks];
    playSong(idx);
}

function openListeningStatsModal() {
    updateListeningStatsDisplay();
    const modal = document.getElementById('listeningStatsModal');
    if (modal) modal.style.display = 'flex';
}

async function loadHomeContent() {
    renderSuggestedPlaylists();
    renderTimeMachine();
    
    const recContainer = document.getElementById('recommendedTracksList');
    if (recContainer) {
        recContainer.innerHTML = `
            <div class="loading-placeholder">
                <div class="loader-spinner"></div>
                <p>Loading recommendations...</p>
            </div>
        `;
    }
    
    try {
        const res = await fetch(`${PROXY_URL}/charts`);
        if (!res.ok) throw new Error("Could not fetch charts");
        const data = await res.json();
        const results = Array.isArray(data) ? data : (data.results || []);
        recommendedTracks = results.map(t => {
            const trackId = t.id || ('track_' + Math.random().toString(36).substr(2, 9));
            return {
                id: trackId,
                title: t.title || t.name || 'Unknown Track',
                artist: t.artist || t.more_info?.singers || 'Unknown Artist',
                image: t.image || 'https://picsum.photos/300/300',
                streamUrl: t.streamUrl || `${PROXY_URL}/stream?id=${trackId}`,
                offlinePath: t.offlinePath
            };
        });
    } catch(e) {
        recommendedTracks = FALLBACK_TRACKS.map(t => ({...t}));
    }
    
    renderRecommendedTracks();
    renderTimeMachine();
}

function renderRecommendedTracks() {
    const container = document.getElementById('recommendedTracksList');
    if (!container) return;
    container.innerHTML = '';
    
    recommendedTracks.forEach((song, idx) => {
        const el = document.createElement('div');
        const isThisPlaying = (queue[currentIndex]?.id === song.id && isPlaying);
        el.className = 'song-item' + (isThisPlaying ? ' is-playing' : '');
        el.id = `rec-song-item-${idx}`;
        el.setAttribute('data-track-id', song.id);
        
        const divTitle = document.createElement('div'); divTitle.textContent = song.title;
        const divArtist = document.createElement('div'); divArtist.textContent = song.artist;
        
        el.innerHTML = `
            <div class="song-cover circle" style="background-image: url('${song.image}');" onclick="playRecommendedSong(${idx})">
                ${isThisPlaying ? '<div class="playing-badge"><i data-lucide="volume-2" style="width:16px;height:16px;"></i></div>' : ''}
            </div>
            <div class="song-info" onclick="playRecommendedSong(${idx})">
                <h3>${divTitle.textContent}</h3>
                <p>${divArtist.textContent}</p>
            </div>
            <button class="menu-dots-btn" title="Options" onclick="event.stopPropagation(); event.preventDefault(); openSongActionMenu(recommendedTracks[${idx}], this)">
                <i data-lucide="more-vertical"></i>
            </button>
        `;
        container.appendChild(el);
    });
    
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: container });
    }
}

function playRecommendedSong(idx) {
    queue = [...recommendedTracks];
    playSong(idx);
}

function playAllRecommended() {
    if (recommendedTracks.length === 0) return;
    queue = [...recommendedTracks];
    playSong(0);
    showToast("Playing recommended tracks");
}

// ==========================================================================
// SONG ACTION MENU & ACTION SHEET COMPONENT (Musify Spec Section 4)
// ==========================================================================

let activeMenuTrack = null;

// Single Source of Truth for Download State
function isTrackDownloaded(trackId) {
    if (!trackId) return false;
    const downloads = getDownloadedSongs();
    return !!downloads.find(s => s.id === trackId);
}

function getDownloadedTrack(trackId) {
    const downloads = getDownloadedSongs();
    return downloads.find(s => s.id === trackId) || null;
}

let menuContextPlaylistId = null;

function openSongActionMenu(track, anchorEl, contextPlaylistId = null) {
    if (!track) return;
    activeMenuTrack = track;
    menuContextPlaylistId = contextPlaylistId || (playlists.some(p => p.id === currentViewPlaylistId) ? currentViewPlaylistId : null);
    updateSongActionSheetUI(track);
    const sheet = document.getElementById('songActionSheetModal');
    if (sheet) sheet.style.display = 'flex';
}

function closeSongActionSheet() {
    const sheet = document.getElementById('songActionSheetModal');
    if (sheet) sheet.style.display = 'none';
}

function updateSongActionSheetUI(track) {
    if (!track) return;
    
    // Header Info
    const coverEl = document.getElementById('sheetTrackCover');
    if (coverEl) coverEl.style.backgroundImage = `url('${track.image || "https://picsum.photos/300/300"}')`;
    
    const titleEl = document.getElementById('sheetTrackTitle');
    if (titleEl) titleEl.textContent = track.title || "Unknown Track";
    
    const artistEl = document.getElementById('sheetTrackArtist');
    if (artistEl) artistEl.textContent = track.artist || "Unknown Artist";
    
    // 3. Liked Songs state check
    const likedPl = playlists.find(p => p.id === 'liked');
    const isLiked = likedPl && likedPl.songs.some(s => s.id === track.id);
    const likeLabel = document.getElementById('menuToggleLikeLabel');
    const likeIcon = document.getElementById('menuLikeIcon');
    if (likeLabel) {
        likeLabel.textContent = isLiked ? "Remove from Liked Songs" : "Add to Liked Songs";
    }
    if (likeIcon) {
        if (isLiked) {
            likeIcon.setAttribute('fill', '#FF4477');
            likeIcon.setAttribute('color', '#FF4477');
        } else {
            likeIcon.removeAttribute('fill');
            likeIcon.setAttribute('color', 'currentColor');
        }
    }
    
    // 5. Download state check from single source of truth
    const isDownloaded = isTrackDownloaded(track.id);
    const dlLabel = document.getElementById('menuDownloadActionLabel');
    const dlWrap = document.getElementById('menuDownloadIconWrap');
    if (dlLabel) {
        dlLabel.textContent = isDownloaded ? "Remove from offline" : "Make offline";
    }
    if (dlWrap) {
        if (isDownloaded) {
            dlWrap.innerHTML = '<i data-lucide="trash-2" style="color:#ff4444;"></i>';
        } else {
            dlWrap.innerHTML = '<i data-lucide="download"></i>';
        }
    }

    // 6. Remove from Playlist option check
    const removePlBtn = document.getElementById('menuRemoveFromPlaylistBtn');
    const removePlLabel = document.getElementById('menuRemoveFromPlaylistLabel');
    if (removePlBtn) {
        if (menuContextPlaylistId && playlists.some(p => p.id === menuContextPlaylistId)) {
            const currentPl = playlists.find(p => p.id === menuContextPlaylistId);
            removePlBtn.style.display = 'flex';
            if (removePlLabel) {
                removePlLabel.textContent = currentPl ? `Remove from "${currentPl.name}"` : "Remove from playlist";
            }
        } else {
            removePlBtn.style.display = 'none';
        }
    }
    
    const sheetModal = document.getElementById('songActionSheetModal');
    if (sheetModal && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: sheetModal });
    }
}

// 6. Remove track from custom playlist
function handleMenuRemoveFromPlaylist() {
    if (!activeMenuTrack || !menuContextPlaylistId) return;
    const pl = playlists.find(p => p.id === menuContextPlaylistId);
    if (pl) {
        pl.songs = pl.songs.filter(s => s.id !== activeMenuTrack.id);
        savePlaylists();
        renderPlaylistDetails(menuContextPlaylistId);
        renderLibrary();
        showToast(`Removed "${activeMenuTrack.title}" from "${pl.name}"`);
    }
    closeSongActionSheet();
}

function removeSongFromPlaylist(playlistId, songId) {
    const pl = playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const song = pl.songs.find(s => s.id === songId);
    const title = song ? song.title : 'Track';
    pl.songs = pl.songs.filter(s => s.id !== songId);
    savePlaylists();
    renderPlaylistDetails(playlistId);
    renderLibrary();
    showToast(`Removed "${title}" from "${pl.name}"`);
}

// 1. Play Next
function handleMenuPlayNext() {
    if (!activeMenuTrack) return;
    const track = activeMenuTrack;
    closeSongActionSheet();

    if (currentIndex >= 0 && currentIndex < queue.length) {
        queue.splice(currentIndex + 1, 0, track);
        showToast(`Playing next: ${track.title}`);
    } else {
        queue = [track];
        currentIndex = 0;
        playSong(0);
        showToast(`Playing now: ${track.title}`);
    }
}

// 2. Add to Queue
function handleMenuAddToQueue() {
    if (!activeMenuTrack) return;
    const track = activeMenuTrack;
    closeSongActionSheet();

    if (queue.length === 0 || currentIndex === -1) {
        queue = [track];
        currentIndex = 0;
        updateUI(track);
        if (miniPlayer) miniPlayer.style.display = 'flex';
        showToast(`Added to queue: ${track.title}`);
    } else {
        queue.push(track);
        showToast(`Added to queue: ${track.title}`);
    }
}

// 3. Add to / Remove from Liked Songs
function handleMenuToggleLike() {
    if (!activeMenuTrack) return;
    const track = activeMenuTrack;
    const likedPl = playlists.find(p => p.id === 'liked');
    if (!likedPl) return;
    
    const existingIdx = likedPl.songs.findIndex(s => s.id === track.id);
    if (existingIdx > -1) {
        likedPl.songs.splice(existingIdx, 1);
        showToast("Removed from Liked Songs");
    } else {
        likedPl.songs.push(track);
        showToast("Added to Liked Songs ❤️");
    }
    
    savePlaylists();
    updateSongActionSheetUI(track);
    updateLikeButtonState(track.id);
    if (document.getElementById('library-screen').classList.contains('active')) {
        renderLibrary();
    }
    if (currentViewPlaylistId === 'liked') {
        renderPlaylistDetails('liked');
    }
}

// 4. Add to Playlist (Sub-sheet)
function handleMenuOpenPlaylistSubsheet() {
    closeSongActionSheet();
    renderPlaylistSubSheet();
    const sub = document.getElementById('playlistSubSheetModal');
    if (sub) sub.style.display = 'flex';
}

function backToMainActionSheet() {
    closePlaylistSubSheet();
    if (activeMenuTrack) {
        openSongActionMenu(activeMenuTrack);
    }
}

function closePlaylistSubSheet() {
    const sub = document.getElementById('playlistSubSheetModal');
    if (sub) sub.style.display = 'none';
}

function renderPlaylistSubSheet() {
    const container = document.getElementById('subSheetPlaylistList');
    if (!container) return;
    container.innerHTML = '';
    
    const customList = playlists.filter(p => p.id !== 'liked');
    if (customList.length === 0) {
        container.innerHTML = '<p style="color:#777; font-size:14px; padding:15px 0; text-align:center;">No custom playlists yet. Tap "Create new playlist" above.</p>';
        return;
    }
    
    customList.forEach(pl => {
        const row = document.createElement('div');
        row.className = 'sheet-playlist-row';
        const coverImg = (pl.songs && pl.songs.length > 0 && pl.songs[0].image) ? pl.songs[0].image : `https://picsum.photos/seed/${pl.id}/100/100`;
        const countText = `${pl.songs.length} ${pl.songs.length === 1 ? 'track' : 'tracks'}`;
        
        row.innerHTML = `
            <div class="sheet-pl-thumb" style="background-image: url('${coverImg}');">
                ${(!pl.songs || pl.songs.length === 0) ? '<i data-lucide="music"></i>' : ''}
            </div>
            <div class="sheet-pl-info">
                <span class="sheet-pl-name">${pl.name}</span>
                <span class="sheet-pl-meta">${countText}</span>
            </div>
            <div class="sheet-pl-add-btn">
                <i data-lucide="plus" style="width:14px;height:14px;"></i>
                <span>Add</span>
            </div>
        `;
        row.onclick = () => {
            if (!activeMenuTrack) return;
            if (!pl.songs.some(s => s.id === activeMenuTrack.id)) {
                pl.songs.push(activeMenuTrack);
                savePlaylists();
                showToast(`Added "${activeMenuTrack.title}" to "${pl.name}"`);
            } else {
                showToast(`Already in "${pl.name}"`);
            }
            closePlaylistSubSheet();
            renderLibrary();
            if (currentViewPlaylistId === pl.id) {
                renderPlaylistDetails(pl.id);
            }
        };
        container.appendChild(row);
    });
    const subSheet = document.getElementById('playlistSubSheetModal');
    if (subSheet && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: subSheet });
    }
}

function handleCreatePlaylistFromSubSheet() {
    closePlaylistSubSheet();
    openCustomPromptModal("NEW PLAYLIST", "", "Enter playlist name...", (name) => {
        if (name && name.trim()) {
            const id = 'pl_' + Date.now();
            const newPl = { id, name: name.trim(), songs: activeMenuTrack ? [activeMenuTrack] : [] };
            playlists.push(newPl);
            savePlaylists();
            renderLibrary();
            showToast(`Created "${name.trim()}" & added track`);
        }
    });
}

// 5. Conditional Download Action: Make offline vs Remove from offline
function handleMenuDownloadAction() {
    if (!activeMenuTrack) return;
    const track = activeMenuTrack;
    closeSongActionSheet();

    if (isTrackDownloaded(track.id)) {
        // Confirm before deleting physical audio file
        openCustomConfirmModal(
            "REMOVE FROM OFFLINE",
            `Remove "${track.title}" from your offline songs?`,
            () => {
                removeDownloadedTrack(track);
            }
        );
    } else {
        downloadTrack(track);
    }
}

async function removeDownloadedTrack(track) {
    if (!track) return;
    const songId = track.id;
    let downloads = getDownloadedSongs();
    const target = downloads.find(s => s.id === songId) || track;
    
    // 1. Delete via backend proxy API
    try {
        await fetch(`${PROXY_URL}/api/downloads/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: songId })
        });
    } catch(e) {}

    // 2. Delete actual audio file from disk if in Electron
    const targetPath = target.offlinePath || target.localPath || track.offlinePath || track.localPath;
    if (true) {
        try {
            /* Removed fsNode unlink */
        } catch(e) {
            console.warn("Could not delete physical file:", e);
        }
    }
    
    // Update track metadata immediately
    track.isDownloaded = false;
    track.offlinePath = null;
    track.localPath = null;
    if (target) {
        target.isDownloaded = false;
        target.offlinePath = null;
        target.localPath = null;
    }
    
    downloads = downloads.filter(s => s.id !== songId);
    saveDownloadManifest(downloads);
    
    if (currentViewPlaylistId === 'downloads') {
        renderPlaylistDetails('downloads');
    }
    renderLibrary();
    updateLibraryBadges();
    showToast(`Removed "${track.title}" from offline songs`);
}

async function downloadTrack(track) {
    if (!track) return;
    if (isTrackDownloaded(track.id)) {
        showToast(`"${track.title}" is already offline!`);
        return;
    }
    
    // Show download progress on matching rows
    const matchingRows = document.querySelectorAll(`[data-track-id="${track.id}"]`);
    matchingRows.forEach(row => {
        row.classList.add('is-downloading');
        let bar = row.querySelector('.download-progress-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'download-progress-bar';
            row.appendChild(bar);
        }
        bar.style.width = '25%';
    });
    
    showToast(`Downloading "${track.title}" for offline...`);

    let progressTimer = setInterval(() => {
        matchingRows.forEach(r => {
            const bar = r.querySelector('.download-progress-bar');
            if (bar) {
                const cur = parseFloat(bar.style.width) || 25;
                if (cur < 85) bar.style.width = (cur + 10) + '%';
            }
        });
    }, 500);

    try {
        const downloadUrl = `${PROXY_URL}/download?id=${encodeURIComponent(track.id)}&title=${encodeURIComponent(track.title || '')}&artist=${encodeURIComponent(track.artist || '')}&image=${encodeURIComponent(track.image || '')}&saveOffline=true`;
        
        const res = await fetch(downloadUrl);
        clearInterval(progressTimer);

        let data = null;
        try {
            data = await res.json();
        } catch(e) {}

        if (!res.ok || !data || !data.success) {
            const errorMsg = (data && data.error) ? data.error : `Server returned status ${res.status}`;
            throw new Error(errorMsg);
        }
        
        if (data.success && data.track) {
            track.isDownloaded = true;
            track.offlinePath = data.track.offlinePath;
            track.streamUrl = data.track.streamUrl;
            
            let currentDownloads = getDownloadedSongs();
            currentDownloads = currentDownloads.filter(s => s.id !== track.id);
            currentDownloads.push(data.track);
            saveDownloadManifest(currentDownloads);
        }

        matchingRows.forEach(r => {
            const bar = r.querySelector('.download-progress-bar');
            if (bar) bar.style.width = '100%';
            setTimeout(() => {
                r.classList.remove('is-downloading');
                if (bar) bar.remove();
            }, 450);
        });

        // POP MESSAGE THAT SONG IS OFFLINE
        showToast(`"${track.title}" is offline`);
        updateLibraryBadges();
        if (currentViewPlaylistId === 'downloads') {
            renderPlaylistDetails('downloads');
        }
        renderLibrary();
    } catch(err) {
        clearInterval(progressTimer);
        console.error("Make offline failed:", err);
        matchingRows.forEach(r => {
            r.classList.remove('is-downloading');
            const bar = r.querySelector('.download-progress-bar');
            if (bar) bar.remove();
        });
        showToast(`Failed to make offline: ${err.message}`);
    }
}

// ==========================================================================
// SEARCH SCREEN LOGIC (Musify Spec Section 2)
// ==========================================================================

function getRecentSearches() {
    try {
        const stored = localStorage.getItem('musify_recent_searches');
        if (stored) {
            let parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                // Filter out any legacy dummy default search terms
                const dummySet = new Set(["top hits 2026", "nirvana", "imagine dragons", "synthwave neon", "lofi beats to relax", "eminem", "deadmau5", "daft punk"]);
                parsed = parsed.filter(item => typeof item === 'string' && item.trim() && !dummySet.has(item.trim().toLowerCase()));
                return parsed;
            }
        }
    } catch(e) {}
    return [];
}

function saveRecentSearches(list) {
    try {
        localStorage.setItem('musify_recent_searches', JSON.stringify(list));
    } catch(e) {}
    renderRecentSearches();
}

function addRecentSearch(query) {
    if (!query || !query.trim()) return;
    const clean = query.trim();
    let searches = getRecentSearches();
    // Dedupe case-insensitively
    searches = searches.filter(item => item.trim().toLowerCase() !== clean.toLowerCase());
    // Prepend (most recent first)
    searches.unshift(clean);
    // Cap at 15
    if (searches.length > 15) {
        searches = searches.slice(0, 15);
    }
    saveRecentSearches(searches);
}

function removeRecentSearch(query, e) {
    if (e) e.stopPropagation();
    let searches = getRecentSearches();
    searches = searches.filter(item => item.trim().toLowerCase() !== query.trim().toLowerCase());
    saveRecentSearches(searches);
}

function clearAllRecentSearches() {
    saveRecentSearches([]);
}

function renderRecentSearches() {
    const listEl = document.getElementById('recentSearchesList');
    const clearBtn = document.getElementById('clearRecentSearchesBtn');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    const searches = getRecentSearches();
    if (clearBtn) {
        clearBtn.style.display = searches.length > 0 ? 'inline-block' : 'none';
    }
    
    if (searches.length === 0) {
        listEl.innerHTML = '<p style="color:#777; font-size:14px; padding:16px 4px; font-weight:600;">No recent searches yet.</p>';
        return;
    }
    
    searches.forEach((query, idx) => {
        const row = document.createElement('div');
        row.className = 'recent-search-row';
        row.onclick = () => {
            const input = document.getElementById('searchInput');
            if (input) input.value = query;
            executeSearch(query);
        };
        
        const blobClass = `blob-${idx % 6}`;
        
        row.innerHTML = `
            <div class="search-blob-avatar ${blobClass}">
                <i data-lucide="search"></i>
            </div>
            <span class="recent-search-query">${query}</span>
            <button class="recent-search-delete-btn" title="Remove" onclick="removeRecentSearch('${query.replace(/'/g, "\\'")}', event)">
                <i data-lucide="x"></i>
            </button>
        `;
        listEl.appendChild(row);
    });
    
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: listEl });
    }
}

let currentSearchFilter = { type: 'all', source: 'online' };

function toggleSearchFilterModal() {
    const m = document.getElementById('searchFilterModal');
    if (m) m.style.display = (m.style.display === 'none' ? 'flex' : 'none');
}

function setSearchFilter(category, val, btn) {
    currentSearchFilter[category] = val;
    if (btn && btn.parentElement) {
        btn.parentElement.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }
}

function applySearchFilter() {
    const m = document.getElementById('searchFilterModal');
    if (m) m.style.display = 'none';
    const input = document.getElementById('searchInput');
    if (input && input.value.trim()) {
        executeSearch(input.value.trim());
    } else {
        showToast(`Search filter: ${currentSearchFilter.type} (${currentSearchFilter.source})`);
    }
}

function resetSearchToRecent() {
    const input = document.getElementById('searchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    
    const resSec = document.getElementById('searchResultsSection');
    if (resSec) resSec.style.display = 'none';
    const recSec = document.getElementById('recentSearchesSection');
    if (recSec) recSec.style.display = 'block';
    
    renderRecentSearches();
}

function clearSearch() {
    resetSearchToRecent();
}

async function executeSearch(query) {
    if (!query || !query.trim()) return;
    const q = query.trim();
    
    // Record in recent searches (most recent first, dedupe case-insensitively, max 15)
    addRecentSearch(q);
    
    const input = document.getElementById('searchInput');
    if (input) input.value = q;
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = 'block';
    
    const recSec = document.getElementById('recentSearchesSection');
    if (recSec) recSec.style.display = 'none';
    const resSec = document.getElementById('searchResultsSection');
    if (resSec) resSec.style.display = 'block';
    
    const headerEl = document.getElementById('searchResultsHeader');
    if (headerEl) headerEl.textContent = `RESULTS FOR "${q.toUpperCase()}"`;
    
    const listEl = document.getElementById('searchResultsList');
    if (!listEl) return;
    listEl.innerHTML = `
        <div class="loading-placeholder">
            <div class="loader-spinner"></div>
            <p>Searching for "${q}"...</p>
        </div>
    `;
    
    // Offline filter check
    if (currentSearchFilter.source === 'offline') {
        const downloads = getDownloadedSongs();
        const filtered = downloads.filter(t => 
            t.title.toLowerCase().includes(q.toLowerCase()) || 
            t.artist.toLowerCase().includes(q.toLowerCase())
        );
        renderSearchResults(filtered);
        return;
    }
    
    try {
        let fetchUrl = `${PROXY_URL}/search?q=${encodeURIComponent(q)}`;
        if (q.includes('youtube.com/') || q.includes('youtu.be/')) {
            fetchUrl = `${PROXY_URL}/playlist?url=${encodeURIComponent(q)}`;
        }
        
        
        // Cold start warning timeout
        let coldStartTimer = setTimeout(() => {
            showToast("Waking up server, please wait...");
            if(listEl) listEl.innerHTML = '<p style="text-align:center; padding: 30px; color:#999; font-weight:700;"><i data-lucide="loader" class="spin"></i><br><br>Waking up Render free tier server... (~30s)</p>';
            try { lucide.createIcons(); } catch(e){}
        }, 3000);
        
        console.log("DEBUG: Calling URL:", fetchUrl);
        const res = await fetch(fetchUrl);
        clearTimeout(coldStartTimer);

        if (!res.ok) throw new Error("Search request failed");
        const data = await res.json();
        const results = Array.isArray(data) ? data : (data.results || data.data?.results || []);
        
        if (results.length === 0) {
            listEl.innerHTML = `<p style="text-align:center; padding: 30px; color:#666; font-weight:700;">No tracks found for "${q}".</p>`;
            return;
        }
        
        renderSearchResults(results);
    } catch(err) {
        console.warn("Online search failed, checking downloads:", err);
        const downloads = getDownloadedSongs();
        const filtered = downloads.filter(t => 
            t.title.toLowerCase().includes(q.toLowerCase()) || 
            t.artist.toLowerCase().includes(q.toLowerCase())
        );
        if (filtered.length > 0) {
            renderSearchResults(filtered);
            showToast("Offline mode. Showing matching downloaded songs.");
        } else {
            const errMsg = err.message || String(err); listEl.innerHTML = `<p style="text-align:center; padding: 30px; color:#d32f2f; font-weight:700;">API Error: ${errMsg}<br>Check if proxy (${PROXY_URL}) is reachable.</p>`;
            showToast("Error: " + errMsg);
        }
    }
}

let searchResultsQueue = [];
function renderSearchResults(results) {
    const listEl = document.getElementById('searchResultsList');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    searchResultsQueue = results.map(t => {
        let image = t.image || 'https://picsum.photos/300/300';
        if (Array.isArray(image)) {
            image = image[image.length - 1]?.link || image[0]?.link || image;
        } else if (typeof image === 'string' && image.includes('50x50')) {
            image = image.replace('50x50', '500x500');
        }
        
        const trackId = t.id || t.trackId || t._id || ('track_' + Math.random().toString(36).substr(2, 9));
        return {
            id: trackId,
            title: t.title || t.name || 'Unknown Track',
            artist: t.more_info?.singers || t.primaryArtists || t.artist || t.subtitle || 'Unknown Artist',
            image: image,
            streamUrl: t.streamUrl || `${PROXY_URL}/stream?id=${trackId}`,
            offlinePath: t.offlinePath
        };
    });
    
    searchResultsQueue.forEach((song, idx) => {
        const el = document.createElement('div');
        const isThisPlaying = (queue[currentIndex]?.id === song.id && isPlaying);
        el.className = 'song-item' + (isThisPlaying ? ' is-playing' : '');
        el.id = `search-item-${idx}`;
        el.setAttribute('data-track-id', song.id);
        
        const divTitle = document.createElement('div'); divTitle.textContent = song.title;
        const divArtist = document.createElement('div'); divArtist.textContent = song.artist;
        
        el.innerHTML = `
            <div class="song-cover circle" style="background-image: url('${song.image}');" onclick="playSearchSong(${idx})">
                ${isThisPlaying ? '<div class="playing-badge"><i data-lucide="volume-2" style="width:16px;height:16px;"></i></div>' : ''}
            </div>
            <div class="song-info" onclick="playSearchSong(${idx})">
                <h3>${divTitle.textContent}</h3>
                <p>${divArtist.textContent}</p>
            </div>
            <button class="menu-dots-btn" title="Options" onclick="event.stopPropagation(); event.preventDefault(); openSongActionMenu(searchResultsQueue[${idx}], this)">
                <i data-lucide="more-vertical"></i>
            </button>
        `;
        listEl.appendChild(el);
    });
    
    if (listEl && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: listEl });
    }
}

function playSearchSong(idx) {
    queue = [...searchResultsQueue];
    playSong(idx);
}

// Global hook for search input
const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

if (searchInput) {
    searchInput.addEventListener('input', () => {
        if (searchClearBtn) {
            searchClearBtn.style.display = searchInput.value.trim() ? 'block' : 'none';
        }
        if (!searchInput.value.trim()) {
            resetSearchToRecent();
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            executeSearch(searchInput.value);
        }
    });
}

// Render Tracks into Chart List
function renderResults(results) {
    chartList.innerHTML = '';
    const arr = Array.isArray(results) ? results : (results.results || []);
    
    queue = arr.map(t => {
        let image = t.image || 'https://picsum.photos/300/300';
        if (Array.isArray(image)) {
            image = image[image.length - 1]?.link || image[0]?.link || image;
        } else if (typeof image === 'string' && image.includes('50x50')) {
            image = image.replace('50x50', '500x500');
        }
        
        const trackId = t.id || t.trackId || t._id || ('track_' + Math.random().toString(36).substr(2, 9));
        return {
            id: trackId,
            title: t.title || t.name || 'Unknown Track',
            artist: t.more_info?.singers || t.primaryArtists || t.artist || t.subtitle || 'Unknown Artist',
            image: image,
            streamUrl: t.streamUrl || `${PROXY_URL}/stream?id=${trackId}`,
            offlinePath: t.offlinePath
        };
    });
    
    queue.forEach((song, idx) => {
        const el = document.createElement('div');
        el.className = 'song-item' + (currentIndex === idx && isPlaying ? ' is-playing' : '');
        el.id = `song-item-${idx}`;
        el.setAttribute('data-track-id', song.id);
        
        const divTitle = document.createElement('div'); divTitle.innerHTML = song.title;
        const divArtist = document.createElement('div'); divArtist.innerHTML = song.artist;
        
        el.innerHTML = `
            <div class="song-cover circle" style="background-image: url('${song.image}');" onclick="playSong(${idx})">
                ${currentIndex === idx && isPlaying ? '<div class="playing-badge"><i data-lucide="volume-2" style="width:16px;height:16px;"></i></div>' : ''}
            </div>
            <div class="song-info" onclick="playSong(${idx})">
                <h3>${divTitle.textContent}</h3>
                <p>${divArtist.textContent}</p>
            </div>
            <button class="menu-dots-btn" title="Options" onclick="event.stopPropagation(); event.preventDefault(); openSongActionMenu(queue[${idx}], this)">
                <i data-lucide="more-vertical"></i>
            </button>
        `;
        chartList.appendChild(el);
    });
    
    if (chartList && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: chartList });
    }
}

// Playback Engine
let currentSongCompletedPlayRecorded = false;
let lastTrackedTimestamp = 0;

async function playSong(idx) {
    if (!queue[idx]) return;
    currentIndex = idx;
    const song = queue[currentIndex];
    currentSongCompletedPlayRecorded = false;
    lastTrackedTimestamp = Math.floor(Date.now() / 1000);
    
    // Resolve stream URL or offline local file
    const downloaded = getDownloadedTrack(song.id);
    if (downloaded) {
        song.isDownloaded = true;
        song.offlinePath = downloaded.offlinePath;
        song.streamUrl = 'file://' + downloaded.offlinePath;
    } else if (song.offlinePath) {
        song.streamUrl = 'file://' + song.offlinePath;
    } else {
        // Fetch direct googlevideo URL to bypass proxy streaming limits
        try {
            const res = await fetch(`${PROXY_URL}/api/get-url?id=${encodeURIComponent(song.id)}`);
            const data = await res.json();
            if (data.url) {
                song.streamUrl = data.url;
            } else {
                song.streamUrl = `${PROXY_URL}/stream?id=${encodeURIComponent(song.id)}`; // fallback
            }
        } catch(e) {
            song.streamUrl = `${PROXY_URL}/stream?id=${encodeURIComponent(song.id)}`; // fallback
        }
    }

    audio.src = song.streamUrl;
    audio.play().then(() => {
        isPlaying = true;
        updatePlayIcons();
    }).catch(err => {
        console.warn("Autoplay error or stream failure:", err);
        showToast("Playback failed to start.");
    });
    
    isPlaying = true;
    hasPlayed = true;
    
    // Add to Recently Played History & track play count
    recordRecentlyPlayed(song);
    recordSongPlay(song);
    renderTimeMachine();
    
    if (!nowPlayingScreen.classList.contains('active')) {
        miniPlayer.style.display = 'flex';
    }
    
    updateUI(song);
    highlightActiveSong();
}

function togglePlay() {
    if (currentIndex < 0 && queue.length > 0) {
        playSong(0);
        return;
    }
    
    if (isPlaying) {
        audio.pause();
        isPlaying = false;
    } else {
        if (audio.src) {
            audio.play();
            isPlaying = true;
        }
    }
    updatePlayIcons();
    highlightActiveSong();
}

function nextSong() {
    if (queue.length === 0) return;
    if (isShuffle) {
        let nextIdx = currentIndex;
        while(nextIdx === currentIndex && queue.length > 1) {
            nextIdx = Math.floor(Math.random() * queue.length);
        }
        currentIndex = nextIdx;
    } else {
        currentIndex = (currentIndex + 1) % queue.length;
    }
    playSong(currentIndex);
}

function prevSong() {
    if (queue.length === 0) return;
    // If more than 3 seconds in, restart track
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    currentIndex = (currentIndex - 1 + queue.length) % queue.length;
    playSong(currentIndex);
}

function updatePlayIcons() {
    const playIconMain = isPlaying ? `<i data-lucide="pause" fill="currentColor"></i>` : `<i data-lucide="play" fill="currentColor"></i>`;
    const miniIcon = isPlaying ? `<i data-lucide="pause" fill="currentColor"></i>` : `<i data-lucide="play" fill="currentColor"></i>`;
    
    const miniBtn = document.getElementById('miniPlayBtn');
    const npBtn = document.getElementById('npPlayBtn');
    const miniPlayerEl = document.getElementById('mini-player');

    if (miniBtn) {
        miniBtn.innerHTML = miniIcon;
    }
    if (npBtn) {
        npBtn.innerHTML = playIconMain;
    }
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        if (miniPlayerEl) lucide.createIcons({ root: miniPlayerEl });
        if (npBtn) lucide.createIcons({ root: npBtn });
    }
}

function highlightActiveSong() {
    document.querySelectorAll('.song-item').forEach((item, idx) => {
        if (idx === currentIndex) {
            item.classList.add('is-playing');
        } else {
            item.classList.remove('is-playing');
        }
    });
}

function updateUI(song) {
    const divTitle = document.createElement('div'); divTitle.innerHTML = song.title;
    const divArtist = document.createElement('div'); divArtist.innerHTML = song.artist;
    
    // Mini Player
    document.getElementById('miniTitle').textContent = divTitle.textContent;
    document.getElementById('miniArtist').textContent = divArtist.textContent;
    const miniCover = document.getElementById('miniCover');
    if (miniCover) miniCover.style.backgroundImage = `url('${song.image}')`;
    
    // Now Playing Screen
    document.getElementById('npTitle').textContent = divTitle.textContent;
    document.getElementById('npArtist').textContent = divArtist.textContent;
    document.getElementById('npCover').src = song.image;
    
    // Update Like Button
    updateLikeButtonState(song.id);

    // Update Download Button State
    updateDownloadBtnState(song.id);

    // Fetch and sync lyrics
    fetchAndRenderLyrics(song.title, song.artist);
    
    updatePlayIcons();
}

function updateDownloadBtnState(trackId) {
    const btn = document.getElementById('npDownloadBtn');
    if (!btn) return;
    const isDl = isTrackDownloaded(trackId);
    if (isDl) {
        btn.innerHTML = `<i data-lucide="trash-2" style="color:#ff4444;"></i>`;
        btn.title = "Remove from offline";
    } else {
        btn.innerHTML = `<i data-lucide="download"></i>`;
        btn.title = "Make offline";
    }
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: btn });
    }
}

// Audio Time Updates & Scrubber Sync
audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isScrubbing) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    
    // Scrubber Waveform SVG Progress
    const progressRect = document.getElementById('npProgressRect');
    if (progressRect) {
        progressRect.setAttribute('width', (audio.currentTime / audio.duration) * 400);
    }
    
    // Scrubber Cursor & Bead
    const cursor = document.getElementById('scrubberCursor');
    if (cursor) {
        cursor.style.left = `${pct}%`;
    }
    
    // Mini Player Progress Track
    const miniFill = document.getElementById('miniProgressFill');
    if (miniFill) {
        miniFill.style.width = `${pct}%`;
    }
    
    // Time labels
    document.getElementById('npTimeCurrent').textContent = fmtTime(audio.currentTime);
    document.getElementById('npTimeTotal').textContent = fmtTime(audio.duration);
    
    // Sync Lyrics Line
    syncActiveLyricLine(audio.currentTime);

    // Track active listening seconds based on real elapsed playback time
    const nowSec = Math.floor(Date.now() / 1000);
    if (!audio.paused && audio.currentTime > 0 && !audio.ended) {
        if (!lastTrackedTimestamp) {
            lastTrackedTimestamp = nowSec;
        } else if (nowSec > lastTrackedTimestamp) {
            const delta = Math.min(nowSec - lastTrackedTimestamp, 4);
            lastTrackedTimestamp = nowSec;
            recordListeningProgress(delta);
        }
    } else {
        lastTrackedTimestamp = 0;
    }

    // Track full playback completion when song reaches the very end
    if (audio.duration && audio.duration > 5 && !currentSongCompletedPlayRecorded) {
        if (audio.currentTime >= audio.duration - 1.0) {
            currentSongCompletedPlayRecorded = true;
            if (queue[currentIndex]) {
                recordCompletedPlay(queue[currentIndex]);
                renderTimeMachine();
            }
        }
    }
});

audio.addEventListener('pause', () => {
    lastTrackedTimestamp = 0;
});

audio.addEventListener('play', () => {
    lastTrackedTimestamp = Math.floor(Date.now() / 1000);
});

audio.addEventListener('ended', () => {
    lastTrackedTimestamp = 0;
    if (!currentSongCompletedPlayRecorded && queue[currentIndex]) {
        currentSongCompletedPlayRecorded = true;
        recordCompletedPlay(queue[currentIndex]);
        renderTimeMachine();
    }
    if (!isRepeat) {
        nextSong();
    }
});

function fmtTime(sec) { 
    if (isNaN(sec) || sec < 0) return '0:00'; 
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60); 
    return m + ':' + s.toString().padStart(2, '0'); 
}

// --- Interactive Waveform Scrubber Logic ---
const waveformBars = document.getElementById('waveformBars');
const scrubTooltip = document.getElementById('scrubTooltip');
let cachedWaveformRect = null;

function getScrubTimeFromEvent(e) {
    const rect = cachedWaveformRect || (waveformBars ? waveformBars.getBoundingClientRect() : { left: 0, width: 1 });
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const offsetX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const ratio = rect.width ? (offsetX / rect.width) : 0;
    return { ratio, time: ratio * (audio.duration || 0) };
}

function onScrubMove(e) {
    if (!isScrubbing || !audio.duration) return;
    const { ratio, time } = getScrubTimeFromEvent(e);
    applyScrubVisual(ratio, time);
}

function onScrubEnd(e) {
    if (isScrubbing && audio.duration) {
        const { time } = getScrubTimeFromEvent(e);
        audio.currentTime = time;
        isScrubbing = false;
        cachedWaveformRect = null;
        if (scrubTooltip) scrubTooltip.style.display = 'none';
    }
    window.removeEventListener('mousemove', onScrubMove);
    window.removeEventListener('mouseup', onScrubEnd);
    window.removeEventListener('touchmove', onScrubMove);
    window.removeEventListener('touchend', onScrubEnd);
}

if (waveformBars) {
    waveformBars.addEventListener('mousedown', (e) => {
        if (!audio.duration) return;
        isScrubbing = true;
        cachedWaveformRect = waveformBars.getBoundingClientRect();
        const { ratio, time } = getScrubTimeFromEvent(e);
        applyScrubVisual(ratio, time);
        window.addEventListener('mousemove', onScrubMove);
        window.addEventListener('mouseup', onScrubEnd);
    });

    // Touch events for mobile
    waveformBars.addEventListener('touchstart', (e) => {
        if (!audio.duration) return;
        isScrubbing = true;
        cachedWaveformRect = waveformBars.getBoundingClientRect();
        const { ratio, time } = getScrubTimeFromEvent(e);
        applyScrubVisual(ratio, time);
        window.addEventListener('touchmove', onScrubMove, { passive: true });
        window.addEventListener('touchend', onScrubEnd);
    }, { passive: true });

    // Tooltip on Hover
    waveformBars.addEventListener('mousemove', (e) => {
        if (!audio.duration || isScrubbing) return;
        const rect = waveformBars.getBoundingClientRect();
        const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const ratio = rect.width ? (offsetX / rect.width) : 0;
        const time = ratio * (audio.duration || 0);
        if (scrubTooltip) {
            scrubTooltip.style.display = 'block';
            scrubTooltip.style.left = `${ratio * 100}%`;
            scrubTooltip.textContent = fmtTime(time);
        }
    });

    waveformBars.addEventListener('mouseleave', () => {
        if (!isScrubbing && scrubTooltip) {
            scrubTooltip.style.display = 'none';
        }
    });
}

function applyScrubVisual(ratio, time) {
    const pct = ratio * 100;
    const progressRect = document.getElementById('npProgressRect');
    if (progressRect) progressRect.setAttribute('width', ratio * 400);
    
    const cursor = document.getElementById('scrubberCursor');
    if (cursor) cursor.style.left = `${pct}%`;
    
    document.getElementById('npTimeCurrent').textContent = fmtTime(time);
    
    if (scrubTooltip) {
        scrubTooltip.style.display = 'block';
        scrubTooltip.style.left = `${pct}%`;
        scrubTooltip.textContent = fmtTime(time);
    }
}

// --- Volume Slider Logic ---
function handleVolumeChange(val) {
    const vol = parseFloat(val);
    audio.volume = vol;
    const fill = document.getElementById('volumeFillBar');
    if (fill) fill.style.width = `${vol * 100}%`;
    const pct = document.getElementById('volumePercent');
    if (pct) pct.textContent = `${Math.round(vol * 100)}%`;
    
    const volIcon = document.getElementById('volumeIcon');
    if (!volIcon) return;
    const targetName = (vol === 0) ? 'volume-x' : (vol < 0.5 ? 'volume-1' : 'volume-2');
    isMuted = (vol === 0);
    const currentName = volIcon.getAttribute('data-lucide') || volIcon.getAttribute('data-current-icon');
    if (currentName !== targetName) {
        volIcon.setAttribute('data-lucide', targetName);
        volIcon.setAttribute('data-current-icon', targetName);
        const parent = volIcon.parentElement || volIcon;
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons({ root: parent });
        }
    }
}

function toggleMute() {
    const slider = document.getElementById('volumeSlider');
    if (isMuted) {
        handleVolumeChange(previousVolume || 0.8);
        slider.value = previousVolume || 0.8;
    } else {
        previousVolume = audio.volume;
        handleVolumeChange(0);
        slider.value = 0;
    }
}

// --- Synced Lyrics Logic ---
function toggleLyricsOverlay() {
    const coverContainer = document.getElementById('npCoverContainer');
    if (coverContainer) {
        coverContainer.classList.toggle('show-lyrics');
    }
}

async function fetchAndRenderLyrics(title, artist) {
    const container = document.getElementById('lyricsLinesContainer');
    if (!container) return;
    
    container.innerHTML = `
        <div class="lyrics-empty-state">
            <p>Searching synchronized lyrics...</p>
        </div>
    `;
    parsedLyrics = [];
    
    try {
        const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
        const query = `track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist)}`;
        const res = await fetch(`https://lrclib.net/api/get?${query}`);
        if (!res.ok) throw new Error('Lyrics not found');
        
        const data = await res.json();
        const rawLrc = data.syncedLyrics;
        
        if (rawLrc) {
            parsedLyrics = parseLRC(rawLrc);
            renderParsedLyrics(parsedLyrics);
        } else if (data.plainLyrics) {
            container.innerHTML = `<div style="padding: 10px; line-height: 1.6; font-weight: 600; text-align: center; color: #ddd;">${data.plainLyrics.replace(/\n/g, '<br>')}</div>`;
        } else {
            container.innerHTML = `<div class="lyrics-empty-state"><p>No lyrics found for this track.</p></div>`;
        }
    } catch(e) {
        container.innerHTML = `<div class="lyrics-empty-state"><p>Instrumental or lyrics unavailable</p></div>`;
    }
}

function parseLRC(lrcText) {
    const lines = lrcText.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
    
    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseInt(match[2]);
            const ms = parseInt(match[3].padEnd(3, '0').substring(0, 3));
            const time = min * 60 + sec + ms / 1000;
            const text = line.replace(timeRegex, '').trim();
            if (text) {
                result.push({ time, text });
            }
        }
    }
    return result.sort((a, b) => a.time - b.time);
}

function renderParsedLyrics(lyrics) {
    const container = document.getElementById('lyricsLinesContainer');
    container.innerHTML = '';
    
    lyrics.forEach((item, index) => {
        const lineEl = document.createElement('div');
        lineEl.className = 'lyric-line';
        lineEl.id = `lyric-line-${index}`;
        lineEl.textContent = item.text;
        lineEl.onclick = () => {
            audio.currentTime = item.time;
        };
        container.appendChild(lineEl);
    });
}

let currentActiveLyricIdx = -1;

function syncActiveLyricLine(currentTime) {
    if (!parsedLyrics || parsedLyrics.length === 0) return;
    
    // Only process if now playing screen or lyrics modal is visible
    const npScreen = document.getElementById('now-playing-screen');
    const lyricsModal = document.getElementById('lyricsModal');
    const isLyricsVisible = (npScreen && npScreen.classList.contains('active')) || (lyricsModal && lyricsModal.style.display !== 'none');
    if (!isLyricsVisible) return;

    let activeIdx = -1;
    for (let i = 0; i < parsedLyrics.length; i++) {
        if (currentTime >= parsedLyrics[i].time) {
            activeIdx = i;
        } else {
            break;
        }
    }
    
    if (activeIdx !== -1 && activeIdx !== currentActiveLyricIdx) {
        currentActiveLyricIdx = activeIdx;
        const container = document.getElementById('lyricsLinesContainer');
        if (!container) return;
        const prev = container.querySelector('.lyric-line.active');
        if (prev) prev.classList.remove('active');
        const targetLine = document.getElementById(`lyric-line-${activeIdx}`);
        if (targetLine) {
            targetLine.classList.add('active');
            targetLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

// --- Recently Played & Library Logic ---

function savePlaylists() {
    localStorage.setItem('playlists', JSON.stringify(playlists));
    updateLibraryBadges();
}

function recordRecentlyPlayed(song) {
    recentlyPlayed = recentlyPlayed.filter(s => s.id !== song.id);
    recentlyPlayed.unshift(song);
    if (recentlyPlayed.length > 50) recentlyPlayed.pop();
    localStorage.setItem('recently_played', JSON.stringify(recentlyPlayed));
    updateLibraryBadges();
}

// Custom In-App Modal Dialog Handlers
let promptCallback = null;
function openCustomPromptModal(title, defaultValue, placeholder, callback) {
    promptCallback = callback;
    const modal = document.getElementById('customPromptModal');
    const titleEl = document.getElementById('customPromptTitle');
    const inputEl = document.getElementById('customPromptInput');
    if (titleEl) titleEl.textContent = title || "ENTER VALUE";
    if (inputEl) {
        inputEl.value = defaultValue || '';
        inputEl.placeholder = placeholder || 'Enter name...';
    }
    if (modal) modal.style.display = 'flex';
    setTimeout(() => { if (inputEl) inputEl.focus(); }, 50);
}

function closeCustomPromptModal() {
    const modal = document.getElementById('customPromptModal');
    if (modal) modal.style.display = 'none';
    promptCallback = null;
}

function submitCustomPromptModal() {
    const inputEl = document.getElementById('customPromptInput');
    const val = inputEl ? inputEl.value.trim() : '';
    if (promptCallback) {
        promptCallback(val);
    }
    closeCustomPromptModal();
}

let confirmCallback = null;
function openCustomConfirmModal(title, message, callback) {
    confirmCallback = callback;
    const modal = document.getElementById('customConfirmModal');
    const titleEl = document.getElementById('customConfirmTitle');
    const msgEl = document.getElementById('customConfirmMessage');
    if (titleEl) titleEl.textContent = title || "CONFIRM ACTION";
    if (msgEl) msgEl.textContent = message || "Are you sure you want to proceed?";
    if (modal) modal.style.display = 'flex';
}

function closeCustomConfirmModal() {
    const modal = document.getElementById('customConfirmModal');
    if (modal) modal.style.display = 'none';
    confirmCallback = null;
}

function submitCustomConfirmModal() {
    if (confirmCallback) {
        confirmCallback();
    }
    closeCustomConfirmModal();
}

function clearRecentlyPlayedHistory() {
    openCustomConfirmModal("CLEAR HISTORY", "Clear your Recently Played history?", () => {
        recentlyPlayed = [];
        localStorage.setItem('recently_played', JSON.stringify(recentlyPlayed));
        updateLibraryBadges();
        showToast("History cleared");
        if (currentViewPlaylistId === 'recently_played') {
            renderPlaylistDetails('recently_played');
        }
    });
}

function updateLibraryBadges() {
    const likedPl = playlists.find(p => p.id === 'liked');
    const likedBadge = document.getElementById('likedCountBadge');
    if (likedBadge) likedBadge.textContent = `${likedPl ? likedPl.songs.length : 0} tracks`;
    
    const recentBadge = document.getElementById('recentCountBadge');
    if (recentBadge) recentBadge.textContent = `${recentlyPlayed.length} tracks`;

    const downloadBadge = document.getElementById('downloadsCountBadge');
    if (downloadBadge) downloadBadge.textContent = `${getDownloadedSongs().length} tracks`;

    if (currentIndex >= 0 && queue[currentIndex]) {
        updateDownloadBtnState(queue[currentIndex].id);
    }
}

function handleCreateFolder() {
    openCustomPromptModal("NEW FOLDER", "", "Enter folder name...", (name) => {
        if (name) {
            const id = 'folder_' + Date.now();
            playlists.push({ id, name: `📁 ${name}`, songs: [] });
            savePlaylists();
            renderLibrary();
            showToast(`Created folder "${name}"`);
        }
    });
}

function handleCreatePlaylist() {
    openCustomPromptModal("NEW PLAYLIST", "", "Enter playlist name...", (name) => {
        if (name) {
            const id = 'pl_' + Date.now();
            playlists.push({ id, name, songs: [] });
            savePlaylists();
            renderLibrary();
            showToast(`Created playlist "${name}"`);
        }
    });
}

function renderLibrary() {
    const container = document.getElementById('libraryPlaylistContainer');
    if (!container) return;
    
    updateLibraryBadges();
    container.innerHTML = '';
    
    const customPlaylists = playlists.filter(p => p.id !== 'liked');
    if (customPlaylists.length === 0) {
        container.innerHTML = '<p style="color: #666; font-size: 14px; padding: 10px 0;">No custom playlists yet. Tap "+" to create one.</p>';
        return;
    }
    
    customPlaylists.forEach(pl => {
        const el = document.createElement('div');
        el.className = 'song-item custom-playlist-item';
        const coverImg = (pl.songs && pl.songs.length > 0 && pl.songs[0].image) ? pl.songs[0].image : `https://picsum.photos/seed/${pl.id}/100/100`;
        const countText = `${pl.songs.length} ${pl.songs.length === 1 ? 'track' : 'tracks'}`;
        el.innerHTML = `
            <div class="song-cover circle" style="background-image: url('${coverImg}'); border-radius:12px;"></div>
            <div class="song-info">
                <h3>${pl.name}</h3>
                <p>${countText}</p>
            </div>
            <i data-lucide="chevron-right" style="color:#000;"></i>
        `;
        el.onclick = () => openPlaylistDetails(pl.id);
        container.appendChild(el);
    });
    
    if (container && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: container });
    }
}

let currentViewPlaylistId = null;

function openPlaylistDetails(id) {
    currentViewPlaylistId = id;
    const titleEl = document.getElementById('detailPlaylistTitle');
    const optionsBtn = document.getElementById('playlistOptionsBtn');
    
    if (id === 'liked') {
        if (titleEl) titleEl.textContent = 'Liked Songs';
        if (optionsBtn) optionsBtn.style.display = 'none';
    } else if (id === 'recently_played') {
        if (titleEl) titleEl.textContent = 'Recently Played';
        if (optionsBtn) optionsBtn.style.display = 'none';
    } else if (id === 'downloads') {
        if (titleEl) titleEl.textContent = 'Downloads';
        if (optionsBtn) optionsBtn.style.display = 'none';
    } else if (id.startsWith('custom_suggested_')) {
        const sugId = id.replace('custom_suggested_', '');
        const sug = SUGGESTED_PLAYLISTS.find(s => s.id === sugId);
        if (titleEl) titleEl.textContent = sug ? sug.title : 'Suggested Playlist';
        if (optionsBtn) optionsBtn.style.display = 'none';
    } else if (id === 'radio_stations') {
        if (titleEl) titleEl.textContent = 'Radio Stations';
        if (optionsBtn) optionsBtn.style.display = 'none';
    } else {
        const pl = playlists.find(p => p.id === id);
        if (!pl) return;
        if (titleEl) titleEl.textContent = pl.name;
        if (optionsBtn) optionsBtn.style.display = 'block';
    }
    
    document.getElementById('playlistActions').style.display = 'none';
    renderPlaylistDetails(id);
    switchMainTab('playlist-detail-screen');
}

function renderPlaylistDetails(id) {
    const container = document.getElementById('playlistSongList');
    if (!container) return;
    container.innerHTML = '';
    
    let trackList = [];
    if (id === 'liked') {
        const pl = playlists.find(p => p.id === 'liked');
        trackList = pl ? pl.songs : [];
    } else if (id === 'recently_played') {
        trackList = recentlyPlayed;
    } else if (id === 'downloads') {
        trackList = getDownloadedSongs();
    } else if (id.startsWith('custom_suggested_')) {
        trackList = currentCustomTracks;
    } else if (id === 'radio_stations') {
        trackList = RADIO_STATIONS;
    } else {
        const pl = playlists.find(p => p.id === id);
        trackList = pl ? pl.songs : [];
    }
    
    if (trackList.length === 0) {
        container.innerHTML = '<p style="color: #666; font-size: 14px; text-align:center; padding: 40px 0;">This collection is empty.</p>';
        return;
    }
    
    const isCustomPl = playlists.some(p => p.id === id && p.id !== 'liked');

    trackList.forEach((song, idx) => {
        const el = document.createElement('div');
        el.className = 'song-item';
        el.setAttribute('data-track-id', song.id);

        let extraRemoveBtn = '';
        if (isCustomPl) {
            extraRemoveBtn = `
                <button class="remove-playlist-song-btn" title="Remove from playlist" onclick="event.stopPropagation(); event.preventDefault(); removeSongFromPlaylist('${id}', '${song.id}')">
                    <i data-lucide="trash-2" style="width:16px;height:16px;color:#ff4444;"></i>
                </button>
            `;
        }

        el.innerHTML = `
            <div class="song-cover circle" style="background-image: url('${song.image || "https://picsum.photos/300/300"}');" onclick="playCollectionTrack('${id}', ${idx})"></div>
            <div class="song-info" onclick="playCollectionTrack('${id}', ${idx})">
                <h3>${song.title}</h3>
                <p>${song.artist}</p>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${extraRemoveBtn}
                <button class="menu-dots-btn" title="Options" onclick="event.stopPropagation(); event.preventDefault(); openSongActionMenu(getCollectionTrack('${id}', ${idx}), this, '${id}')">
                    <i data-lucide="more-vertical"></i>
                </button>
            </div>
        `;
        container.appendChild(el);
    });
    
    if (container && typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({ root: container });
    }
}

function getCollectionTrack(id, idx) {
    if (id === 'liked') return playlists.find(p => p.id === 'liked')?.songs[idx];
    if (id === 'recently_played') return recentlyPlayed[idx];
    if (id === 'downloads') return getDownloadedSongs()[idx];
    if (id.startsWith('custom_suggested_')) return currentCustomTracks[idx];
    if (id === 'radio_stations') return RADIO_STATIONS[idx];
    return playlists.find(p => p.id === id)?.songs[idx];
}

function playCollectionTrack(id, idx) {
    let trackList = [];
    if (id === 'liked') {
        trackList = playlists.find(p => p.id === 'liked')?.songs || [];
    } else if (id === 'recently_played') {
        trackList = recentlyPlayed;
    } else if (id === 'downloads') {
        trackList = getDownloadedSongs();
    } else if (id.startsWith('custom_suggested_')) {
        trackList = currentCustomTracks;
    } else if (id === 'radio_stations') {
        trackList = RADIO_STATIONS;
    } else {
        trackList = playlists.find(p => p.id === id)?.songs || [];
    }
    
    queue = [...trackList];
    playSong(idx);
}

function playCurrentPlaylistFromStart() {
    if (currentViewPlaylistId) {
        playCollectionTrack(currentViewPlaylistId, 0);
    }
}

function shuffleCurrentPlaylist() {
    if (!currentViewPlaylistId) return;
    let trackList = [];
    if (currentViewPlaylistId === 'liked') trackList = playlists.find(p => p.id === 'liked')?.songs || [];
    else if (currentViewPlaylistId === 'recently_played') trackList = recentlyPlayed;
    else if (currentViewPlaylistId === 'downloads') trackList = getDownloadedSongs();
    else if (currentViewPlaylistId.startsWith('custom_suggested_')) trackList = currentCustomTracks;
    else if (currentViewPlaylistId === 'radio_stations') trackList = RADIO_STATIONS;
    else trackList = playlists.find(p => p.id === currentViewPlaylistId)?.songs || [];
    
    if (trackList.length > 0) {
        queue = [...trackList].sort(() => Math.random() - 0.5);
        playSong(0);
        showToast("Shuffled playlist");
    }
}

function removeSongFromCollection(playlistId, songId) {
    if (playlistId === 'downloads') {
        let downloads = getDownloadedSongs();
        const target = downloads.find(s => s.id === songId);
        if (target && target.offlinePath && fsNode.existsSync(target.offlinePath)) {
            try {
                /* Removed fsNode unlink */
            } catch (e) {
                console.warn("Could not delete physical file:", e);
            }
        }
        downloads = downloads.filter(s => s.id !== songId);
        saveDownloadManifest(downloads);
        renderPlaylistDetails('downloads');
        renderLibrary();
        showToast("Removed from downloads");
        return;
    }

    const pl = playlists.find(p => p.id === playlistId);
    if (pl) {
        pl.songs = pl.songs.filter(s => s.id !== songId);
        savePlaylists();
        renderPlaylistDetails(playlistId);
        renderLibrary();
        showToast("Removed from playlist");
    }
}

document.getElementById('playlistOptionsBtn').onclick = () => {
    const actions = document.getElementById('playlistActions');
    actions.style.display = actions.style.display === 'none' ? 'flex' : 'none';
};

function handleEditPlaylist() {
    const pl = playlists.find(p => p.id === currentViewPlaylistId);
    if (pl && pl.id !== 'liked') {
        openCustomPromptModal("RENAME PLAYLIST", pl.name, "Enter new name...", (newName) => {
            if (newName) {
                pl.name = newName;
                savePlaylists();
                document.getElementById('detailPlaylistTitle').textContent = pl.name;
                renderLibrary();
                showToast("Playlist renamed");
            }
        });
    }
}

function handleDeletePlaylist() {
    if (currentViewPlaylistId && currentViewPlaylistId !== 'liked') {
        openCustomConfirmModal("DELETE PLAYLIST", "Delete this playlist permanently?", () => {
            playlists = playlists.filter(p => p.id !== currentViewPlaylistId);
            savePlaylists();
            renderLibrary();
            switchMainTab('library-screen');
            showToast("Playlist deleted");
        });
    }
}

// Add To Playlist Modal
let songToAdd = null;
function showAddToPlaylistModal(song) {
    songToAdd = song;
    const modal = document.getElementById('addToPlaylistModal');
    const list = document.getElementById('modalPlaylistList');
    list.innerHTML = '';
    
    playlists.forEach(pl => {
        const btn = document.createElement('button');
        btn.className = 'neo-action-btn';
        btn.style.textAlign = 'left';
        btn.style.justifyContent = 'flex-start';
        btn.textContent = pl.name;
        btn.onclick = () => {
            if (!pl.songs.some(s => s.id === songToAdd.id)) {
                pl.songs.push(songToAdd);
                savePlaylists();
                renderLibrary();
                if (currentViewPlaylistId === pl.id) renderPlaylistDetails(pl.id);
                showToast(`Added to ${pl.name}`);
            } else {
                showToast(`Already in ${pl.name}`);
            }
            modal.style.display = 'none';
        };
        list.appendChild(btn);
    });
    
    modal.style.display = 'flex';
}

function createNewPlaylistAndAdd() {
    openCustomPromptModal("NEW PLAYLIST", "", "Enter playlist name...", (name) => {
        if (name) {
            const id = 'pl_' + Date.now();
            const newPl = { id, name, songs: songToAdd ? [songToAdd] : [] };
            playlists.push(newPl);
            savePlaylists();
            renderLibrary();
            const addModal = document.getElementById('addToPlaylistModal');
            if (addModal) addModal.style.display = 'none';
            showToast(`Created & added to "${name}"`);
        }
    });
}

// Navigation Tabs
function switchMainTab(screenId) {
    ['home-screen', 'search-screen', 'library-screen', 'profile-screen', 'playlist-detail-screen'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            el.style.display = '';
        }
    });
    
    const target = document.getElementById(screenId);
    if (target) {
        target.classList.add('active');
        if (screenId === 'playlist-detail-screen') target.style.display = 'flex';
    }
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav-item').forEach(el => el.classList.remove('active'));
    
    const tabIdMap = {
        'home-screen': 'nav-home',
        'search-screen': 'nav-search',
        'library-screen': 'nav-library',
        'profile-screen': 'nav-settings'
    };
    const sidebarTabMap = {
        'home-screen': 'sidebar-nav-home',
        'search-screen': 'sidebar-nav-search',
        'library-screen': 'sidebar-nav-library',
        'profile-screen': 'sidebar-nav-settings'
    };

    const navEl = document.getElementById(tabIdMap[screenId]);
    if (navEl) {
        navEl.classList.add('active');
    }

    const sNavEl = document.getElementById(sidebarTabMap[screenId]);
    if (sNavEl) {
        sNavEl.classList.add('active');
    }

    if (screenId === 'search-screen') {
        renderRecentSearches();
    } else if (screenId === 'library-screen') {
        renderLibrary();
    }
}

// Controls
function toggleRepeat() {
    isRepeat = !isRepeat;
    audio.loop = isRepeat;
    const btn = document.getElementById('repeatBtn');
    btn.classList.toggle('active-state', isRepeat);
    showToast(isRepeat ? "Loop single track: ON" : "Loop single track: OFF");
}

function toggleShuffle() {
    isShuffle = !isShuffle;
    const btn = document.getElementById('shuffleBtn');
    btn.classList.toggle('active-state', isShuffle);
    showToast(isShuffle ? "Shuffle mode: ON" : "Shuffle mode: OFF");
}

function toggleLikeCurrentSong() {
    if (currentIndex < 0 || !queue[currentIndex]) return;
    const song = queue[currentIndex];
    const likedPl = playlists.find(p => p.id === 'liked');
    const existingIdx = likedPl.songs.findIndex(s => s.id === song.id);
    
    if (existingIdx > -1) {
        likedPl.songs.splice(existingIdx, 1);
        showToast("Removed from Liked Songs");
    } else {
        likedPl.songs.push(song);
        showToast("Added to Liked Songs ❤️");
    }
    
    savePlaylists();
    updateLikeButtonState(song.id);
    if (document.getElementById('library-screen').classList.contains('active')) {
        renderLibrary();
    }
}

function updateLikeButtonState(songId) {
    const likedPl = playlists.find(p => p.id === 'liked');
    const isLiked = likedPl && likedPl.songs.some(s => s.id === songId);
    const npLikeBtn = document.getElementById('npLikeBtn');
    if (npLikeBtn) {
        if (isLiked) {
            npLikeBtn.innerHTML = '<i data-lucide="heart" fill="#FF4477" color="#FF4477"></i>';
        } else {
            npLikeBtn.innerHTML = '<i data-lucide="heart"></i>';
        }
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons({ root: npLikeBtn });
        }
    }
}

// Top Charts Load
async function loadCharts() {
    chartsTitle.textContent = "TOP CHARTS";
    chartList.innerHTML = `
        <div class="loading-placeholder">
            <div class="loader-spinner"></div>
            <p>Loading Billboard Top Hits...</p>
        </div>
    `;
    
    try {
        const res = await fetch(`${PROXY_URL}/charts`);
        if (!res.ok) throw new Error("Could not fetch charts");
        const data = await res.json();
        renderResults(data);
    } catch(err) {
        console.warn("Backend proxy charts offline, loading curated fallback list:", err);
        renderResults(FALLBACK_TRACKS);
        showToast("Offline mode: loaded curated tracks.");
    }
}

// Shortcuts Modal
function toggleShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) {
        modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
    }
}

// Global Keyboard Hotkeys
window.addEventListener('keydown', (e) => {
    // Ignore hotkeys when typing in search or input fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
    }
    
    switch(e.code) {
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowRight':
            e.preventDefault();
            if (audio.duration) {
                audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
                showToast(`Seek +5s (${fmtTime(audio.currentTime)})`);
            }
            break;
        case 'ArrowLeft':
            e.preventDefault();
            if (audio.duration) {
                audio.currentTime = Math.max(0, audio.currentTime - 5);
                showToast(`Seek -5s (${fmtTime(audio.currentTime)})`);
            }
            break;
        case 'KeyN':
            nextSong();
            break;
        case 'KeyP':
            prevSong();
            break;
        case 'KeyM':
            toggleMute();
            break;
        case 'KeyL':
            toggleLyricsOverlay();
            break;
        case 'ArrowUp':
            e.preventDefault();
            handleVolumeChange(Math.min(1, audio.volume + 0.1));
            document.getElementById('volumeSlider').value = audio.volume;
            break;
        case 'ArrowDown':
            e.preventDefault();
            handleVolumeChange(Math.max(0, audio.volume - 0.1));
            document.getElementById('volumeSlider').value = audio.volume;
            break;
        case 'Escape':
            document.querySelectorAll('.modal-backdrop').forEach(m => m.style.display = 'none');
            if (nowPlayingScreen.classList.contains('active')) toggleScreens();
            break;
    }
});

// Startup Initialization
function initializeApp() {
    console.log("[App] Initialization started");
    
    // ALWAYS hide splash screen immediately, regardless of subsequent errors
    const splash = document.getElementById("splash-screen");
    if(splash) {
        console.log("[App] Hiding splash screen");
        splash.classList.add("hidden");
        setTimeout(() => splash.style.display = "none", 500);
    }

    try {
        syncOfflineDownloadsWithBackend();
        renderLibrary();
        loadHomeContent();
        updateLibraryBadges();
        
        // Add event listeners
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
        
        // Auto-update charts periodically
        setInterval(loadHomeContent, 600000); 
        
        // Theme setup
        const savedTheme = localStorage.getItem('theme') || 'system';
        if (typeof setTheme === 'function') {
            setTheme(savedTheme);
        }
    } catch(e) {
        console.error("[App] Error during initialization logic:", e);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    console.log("[App] DOMContentLoaded fired");
    if (window.cordova) {
        console.log("[App] Cordova detected, waiting for deviceready");
        document.addEventListener("deviceready", () => {
            console.log("[App] deviceready fired");
            initializeApp();
        }, false);
        
        // Fallback in case deviceready gets lost (happens in some webviews)
        setTimeout(() => {
            if(!window.__appInitialized) {
                console.log("[App] deviceready timeout fallback!");
                initializeApp();
            }
        }, 8000);
    } else {
        console.log("[App] Browser mode detected, initializing immediately");
        initializeApp();
    }
});

// Guard flag
window.__appInitialized = false;
const oldInit = initializeApp;
initializeApp = function() {
    if(window.__appInitialized) return;
    window.__appInitialized = true;
    oldInit();
};

function downloadCurrentSong() {
    if (currentIndex < 0 || !queue[currentIndex]) {
        showToast("No song currently playing.");
        return;
    }
    const song = queue[currentIndex];
    if (isTrackDownloaded(song.id)) {
        openCustomConfirmModal(
            "REMOVE FROM OFFLINE",
            `Remove "${song.title}" from your offline songs?`,
            () => {
                removeDownloadedTrack(song);
            }
        );
    } else {
        downloadTrack(song);
    }
}





// Network Listeners
window.addEventListener('offline', () => {
    showToast("Internet connection lost. Switching to Offline Mode.");
    if (document.getElementById('home-screen').classList.contains('active')) {
        loadCharts(); // Will now load downloads
    }
});

window.addEventListener('online', () => {
    showToast("Internet restored! Going back online.");
    if (document.getElementById('home-screen').classList.contains('active')) {
        loadCharts(); // Will load actual charts
    }
});


// --- CAPACITOR MEDIA SESSION INTEGRATION ---
if (window.Capacitor && window.Capacitor.Plugins.MediaSession) {
    const MediaSession = window.Capacitor.Plugins.MediaSession;
    
    // 1. Hook up lock-screen controls
    MediaSession.setActionHandler({ action: 'play' }, () => {
        if (typeof audio !== 'undefined' && audio) audio.play();
    });
    MediaSession.setActionHandler({ action: 'pause' }, () => {
        if (typeof audio !== 'undefined' && audio) audio.pause();
    });
    MediaSession.setActionHandler({ action: 'previoustrack' }, () => {
        if (typeof prevSong === 'function') prevSong();
    });
    MediaSession.setActionHandler({ action: 'nexttrack' }, () => {
        if (typeof nextSong === 'function') nextSong();
    });
    
    // 2. Intercept updateUI to push metadata to the lock screen
    if (typeof updateUI === 'function') {
        const originalUpdateUI = updateUI;
        updateUI = function(song) {
            originalUpdateUI(song);
            try {
                // Strip HTML entities that might be in title/artist (like &amp;)
                const divT = document.createElement('div'); divT.innerHTML = song.title || 'Unknown Title';
                const divA = document.createElement('div'); divA.innerHTML = song.artist || 'Unknown Artist';
                
                MediaSession.setMetadata({
                    title: divT.textContent,
                    artist: divA.textContent,
                    album: 'Horizon',
                    artwork: [
                        { src: song.image || 'https://picsum.photos/512/512', sizes: '512x512', type: 'image/jpeg' }
                    ]
                });
            } catch(e) { console.error('MediaSession error:', e); }
        };
    }
    
    // 3. Keep playback state in sync
    if (typeof audio !== 'undefined' && audio) {
        audio.addEventListener('play', () => {
            MediaSession.setPlaybackState({ playbackState: 'playing' }).catch(()=>{});
        });
        audio.addEventListener('pause', () => {
            MediaSession.setPlaybackState({ playbackState: 'paused' }).catch(()=>{});
        });
    }
}
