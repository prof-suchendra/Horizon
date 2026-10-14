package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Track struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Artist       string `json:"artist"`
	Image        string `json:"image"`
	OfflinePath  string `json:"offlinePath,omitempty"`
	IsDownloaded bool   `json:"isDownloaded,omitempty"`
}

type SearchResponse struct {
	Results []Track `json:"results"`
	Error   string  `json:"error,omitempty"`
}

type YtDlpEntry struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Uploader   string `json:"uploader"`
	Channel    string `json:"channel"`
	Thumbnail  string `json:"thumbnail"`
	Thumbnails []struct {
		URL    string `json:"url"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"thumbnails"`
}

var (
	cacheMu     sync.RWMutex
	searchCache = make(map[string]searchCacheItem)
	streamCache = make(map[string]cacheItem)
	musicDir    string
	manifestDir string
	cookiesFile string

	// Concurrency limiter: Render's free tier has a hard 512MB RAM ceiling.
	// Spawning multiple unconstrained yt-dlp processes triggers OOM kills.
	// We limit concurrent yt-dlp invocations to 3 to keep RAM usage safely under 200MB.
	procSem = make(chan struct{}, 3)
)

const (
	maxSearchCacheEntries = 100 // Cap in-memory entries to keep RAM low
	maxStreamCacheEntries = 200
)

type searchCacheItem struct {
	results   []Track
	expiresAt time.Time
}

type cacheItem struct {
	url       string
	expiresAt time.Time
}

// Fallback extractor clients for Render when datacenter IP triggers a 429/bot block
var fallbackClients = []string{
	"android",
	"ios",
	"web_creator",
	"mweb",
	"",
}

// locateCookiesFile verifies if Render mounted the secret file or uses a local fallback
func locateCookiesFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	candidates := []string{
		os.Getenv("YOUTUBE_COOKIES_PATH"),
		"/etc/secrets/youtube_cookies.txt", // Default Render Secret File path
		"/etc/secrets/cookies.txt",
		"/etc/horizon/cookies.txt",
		filepath.Join(home, "Music", "Horizon", "cookies.txt"),
		filepath.Join(home, "Music", "Horizon", "yt_cookies.json"),
		"cookies.txt",
	}
	for _, c := range candidates {
		if c != "" {
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}
	return ""
}

func init() {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	musicDir = filepath.Join(home, "Music", "Horizon")
	manifestDir = filepath.Join(musicDir, "downloads.json")
	_ = os.MkdirAll(musicDir, 0755)

	cookiesFile = locateCookiesFile()
	if cookiesFile != "" {
		log.Printf("[Horizon Backend] YouTube cookies active from: %s", cookiesFile)
	} else {
		log.Printf("[Horizon Backend] Running without cookies (use Render Secret File 'youtube_cookies.txt' if 429 occurs)")
	}
}

// pruneSearchCacheLocked evicts expired or excess search entries to keep memory bounded
func pruneSearchCacheLocked() {
	now := time.Now()
	for k, v := range searchCache {
		if now.After(v.expiresAt) {
			delete(searchCache, k)
		}
	}
	if len(searchCache) > maxSearchCacheEntries {
		for k := range searchCache {
			delete(searchCache, k)
			if len(searchCache) <= maxSearchCacheEntries {
				break
			}
		}
	}
}

// pruneStreamCacheLocked evicts expired or excess stream entries to keep memory bounded
func pruneStreamCacheLocked() {
	now := time.Now()
	for k, v := range streamCache {
		if now.After(v.expiresAt) {
			delete(streamCache, k)
		}
	}
	if len(streamCache) > maxStreamCacheEntries {
		for k := range streamCache {
			delete(streamCache, k)
			if len(streamCache) <= maxStreamCacheEntries {
				break
			}
		}
	}
}

func getYtDlpPath() string {
	candidates := []string{
		"/home/songoku/.local/bin/yt-dlp",
		filepath.Join(os.Getenv("HOME"), ".local", "bin", "yt-dlp"),
		"yt-dlp",
	}
	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			return path
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "yt-dlp"
}

func getNodePath() string {
	if path, err := exec.LookPath("node"); err == nil {
		return path
	}
	if _, err := os.Stat("/usr/bin/node"); err == nil {
		return "/usr/bin/node"
	}
	return ""
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func getManifest() []Track {
	data, err := os.ReadFile(manifestDir)
	if err != nil {
		return []Track{}
	}
	var tracks []Track
	if err := json.Unmarshal(data, &tracks); err != nil {
		return []Track{}
	}
	return tracks
}

func saveManifest(tracks []Track) error {
	data, err := json.MarshalIndent(tracks, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestDir, data, 0644)
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"message": "Horizon Go Proxy Online",
	})
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		json.NewEncoder(w).Encode(SearchResponse{Results: []Track{}})
		return
	}

	// 1. Fast Cache Check with TTL
	cacheMu.RLock()
	if cached, ok := searchCache[q]; ok && time.Now().Before(cached.expiresAt) {
		cacheMu.RUnlock()
		json.NewEncoder(w).Encode(SearchResponse{Results: cached.results})
		return
	}
	cacheMu.RUnlock()

	// 2. Concurrency limiting to respect Render 512MB RAM ceiling
	procSem <- struct{}{}
	defer func() { <-procSem }()

	ytDlp := getYtDlpPath()
	nodePath := getNodePath()

	args := []string{
		"--quiet",
		"--no-warnings",
		"-j",
		"--flat-playlist",
		"--default-search", "ytsearch20",
	}
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	if nodePath != "" {
		args = append(args, "--js-runtimes", fmt.Sprintf("node:%s", nodePath))
	}
	args = append(args, q)

	cmd := exec.Command(ytDlp, args...)
	out, err := cmd.Output()
	if err != nil {
		log.Printf("Search error for '%s': %v", q, err)
		json.NewEncoder(w).Encode(SearchResponse{Results: []Track{}, Error: err.Error()})
		return
	}

	var results []Track
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry YtDlpEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.ID == "" {
			continue
		}

		artist := entry.Uploader
		if artist == "" {
			artist = entry.Channel
		}
		if artist == "" {
			artist = "YouTube"
		}

		thumb := entry.Thumbnail
		if thumb == "" && len(entry.Thumbnails) > 0 {
			thumb = entry.Thumbnails[len(entry.Thumbnails)-1].URL
		}
		if thumb == "" {
			thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", entry.ID)
		}

		results = append(results, Track{
			ID:     entry.ID,
			Title:  entry.Title,
			Artist: artist,
			Image:  thumb,
		})
	}

	cacheMu.Lock()
	pruneSearchCacheLocked()
	searchCache[q] = searchCacheItem{
		results:   results,
		expiresAt: time.Now().Add(6 * time.Hour),
	}
	cacheMu.Unlock()

	json.NewEncoder(w).Encode(SearchResponse{Results: results})
}

func handleCharts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := "Top Hits Billboard"

	cacheMu.RLock()
	if cached, ok := searchCache[q]; ok && time.Now().Before(cached.expiresAt) {
		cacheMu.RUnlock()
		json.NewEncoder(w).Encode(SearchResponse{Results: cached.results})
		return
	}
	cacheMu.RUnlock()

	procSem <- struct{}{}
	defer func() { <-procSem }()

	ytDlp := getYtDlpPath()
	nodePath := getNodePath()

	args := []string{
		"--quiet",
		"--no-warnings",
		"-j",
		"--flat-playlist",
		"--default-search", "ytsearch20",
	}
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	if nodePath != "" {
		args = append(args, "--js-runtimes", fmt.Sprintf("node:%s", nodePath))
	}
	args = append(args, q)

	cmd := exec.Command(ytDlp, args...)
	out, err := cmd.Output()
	if err != nil {
		log.Printf("Charts error: %v", err)
		json.NewEncoder(w).Encode(SearchResponse{Results: []Track{}})
		return
	}

	var results []Track
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry YtDlpEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.ID == "" {
			continue
		}

		artist := entry.Uploader
		if artist == "" {
			artist = entry.Channel
		}
		if artist == "" {
			artist = "Top Music"
		}

		thumb := entry.Thumbnail
		if thumb == "" && len(entry.Thumbnails) > 0 {
			thumb = entry.Thumbnails[len(entry.Thumbnails)-1].URL
		}
		if thumb == "" {
			thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", entry.ID)
		}

		results = append(results, Track{
			ID:     entry.ID,
			Title:  entry.Title,
			Artist: artist,
			Image:  thumb,
		})
	}

	cacheMu.Lock()
	pruneSearchCacheLocked()
	searchCache[q] = searchCacheItem{
		results:   results,
		expiresAt: time.Now().Add(6 * time.Hour),
	}
	cacheMu.Unlock()

	json.NewEncoder(w).Encode(SearchResponse{Results: results})
}

// runYtDlpExtraction executes yt-dlp for a given client and cookies configuration
func runYtDlpExtraction(ctx context.Context, videoID, client, cookiePath string) (string, error) {
	ytDlp := getYtDlpPath()
	nodePath := getNodePath()

	args := []string{
		"-f", "bestaudio[ext=m4a]/bestaudio/best",
		"-g",
		"--quiet",
		"--no-warnings",
		"--no-check-certificates",
	}

	if cookiePath != "" {
		args = append(args, "--cookies", cookiePath)
	}

	if client != "" {
		args = append(args, "--extractor-args", fmt.Sprintf("youtube:player_client=%s", client))
	}

	if nodePath != "" {
		args = append(args, "--js-runtimes", fmt.Sprintf("node:%s", nodePath))
	}

	args = append(args, fmt.Sprintf("https://www.youtube.com/watch?v=%s", videoID))

	cmd := exec.CommandContext(ctx, ytDlp, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return "", fmt.Errorf("cmd failed: %w | stderr: %s", err, strings.TrimSpace(stderr.String()))
	}

	streamURL := strings.TrimSpace(stdout.String())
	if streamURL == "" {
		return "", fmt.Errorf("empty stream url returned")
	}

	// Multiple lines can be returned if video has multiple formats; take the first audio URL
	lines := strings.Split(streamURL, "\n")
	firstURL := strings.TrimSpace(lines[0])
	return firstURL, nil
}

// extractStreamURL resolves audio stream URL with caching, client rotation, and exponential backoff
func extractStreamURL(id string) (string, error) {
	cacheMu.RLock()
	if item, ok := streamCache[id]; ok && time.Now().Before(item.expiresAt) {
		cacheMu.RUnlock()
		return item.url, nil
	}
	cacheMu.RUnlock()

	procSem <- struct{}{}
	defer func() { <-procSem }()

	cookiePath := locateCookiesFile()
	maxRetries := len(fallbackClients)
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		targetClient := fallbackClients[attempt]

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		url, err := runYtDlpExtraction(ctx, id, targetClient, cookiePath)
		cancel()

		if err == nil && url != "" {
			cacheMu.Lock()
			pruneStreamCacheLocked()
			streamCache[id] = cacheItem{
				url:       url,
				expiresAt: time.Now().Add(4 * time.Hour),
			}
			cacheMu.Unlock()
			return url, nil
		}

		lastErr = err
		errStr := strings.ToLower(err.Error())

		// Check for rate-limiting, sign-in, or bot detection signals
		isBlocked := strings.Contains(errStr, "429") ||
			strings.Contains(errStr, "too many requests") ||
			strings.Contains(errStr, "bot") ||
			strings.Contains(errStr, "sign in to confirm")

		if !isBlocked && attempt > 0 {
			break
		}

		// Jittered exponential backoff: (base * 2^attempt) + jitter
		backoff := time.Duration(math.Pow(2, float64(attempt))) * time.Second
		jitter := time.Duration(rand.Intn(500)) * time.Millisecond
		sleepDuration := backoff + jitter

		log.Printf("[Warn] yt-dlp attempt %d failed for %s (client: '%s'): %v. Retrying in %v...",
			attempt+1, id, targetClient, err, sleepDuration)

		time.Sleep(sleepDuration)
	}

	return "", fmt.Errorf("extraction exhausted after retries: %w", lastErr)
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		id = strings.TrimSpace(r.URL.Query().Get("v"))
	}
	if id == "" {
		http.Error(w, `{"error":"Missing 'id' or 'v' query parameter"}`, http.StatusBadRequest)
		return
	}

	streamURL, err := extractStreamURL(id)
	if err != nil {
		log.Printf("Stream error for %s: %v", id, err)
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusTooManyRequests)
		return
	}

	// Option A: If client requested raw URL redirect via ?redirect=true
	if r.URL.Query().Get("redirect") == "true" {
		http.Redirect(w, r, streamURL, http.StatusTemporaryRedirect)
		return
	}

	// Option B: Stream audio bytes through proxy with full Range support
	// This solves the fatal issue where googlevideo.com URLs are IP-bound to Render's datacenter
	// and rejected with HTTP 403 Forbidden or CORS blocked when accessed by client browser.
	client := &http.Client{
		Timeout: 0, // No overall timeout; streaming can be arbitrarily long
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, streamURL, nil)
	if err != nil {
		http.Redirect(w, r, streamURL, http.StatusTemporaryRedirect)
		return
	}

	// Forward Range header if client requests seeking/scrubbing
	if rangeHdr := r.Header.Get("Range"); rangeHdr != "" {
		proxyReq.Header.Set("Range", rangeHdr)
	}
	proxyReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := client.Do(proxyReq)
	if err != nil {
		log.Printf("Proxy stream request failed, falling back to redirect: %v", err)
		http.Redirect(w, r, streamURL, http.StatusTemporaryRedirect)
		return
	}
	defer resp.Body.Close()

	// Forward response headers with full CORS and seeking headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type, Accept")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
	w.Header().Set("Accept-Ranges", "bytes")

	if cType := resp.Header.Get("Content-Type"); cType != "" {
		w.Header().Set("Content-Type", cType)
	} else {
		w.Header().Set("Content-Type", "audio/mp4")
	}
	if cLen := resp.Header.Get("Content-Length"); cLen != "" {
		w.Header().Set("Content-Length", cLen)
	}
	if cRange := resp.Header.Get("Content-Range"); cRange != "" {
		w.Header().Set("Content-Range", cRange)
	}

	w.WriteHeader(resp.StatusCode)
	if r.Method != http.MethodHead {
		io.Copy(w, resp.Body)
	}
}

func handleGetURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		http.Error(w, `{"error":"Missing id"}`, http.StatusBadRequest)
		return
	}

	streamURL, err := extractStreamURL(id)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]string{"url": streamURL})
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	artist := strings.TrimSpace(r.URL.Query().Get("artist"))
	image := strings.TrimSpace(r.URL.Query().Get("image"))

	if id == "" {
		http.Error(w, `{"success":false,"error":"Missing id"}`, http.StatusBadRequest)
		return
	}

	outTemplate := filepath.Join(musicDir, fmt.Sprintf("%s.%%(ext)s", id))
	ytDlp := getYtDlpPath()
	nodePath := getNodePath()

	procSem <- struct{}{}
	defer func() { <-procSem }()

	args := []string{
		"--quiet",
		"--no-warnings",
		"-f", "bestaudio[ext=m4a]/bestaudio/best",
		"-o", outTemplate,
	}
	if cookiesFile != "" {
		args = append(args, "--cookies", cookiesFile)
	}
	if nodePath != "" {
		args = append(args, "--js-runtimes", fmt.Sprintf("node:%s", nodePath))
	}
	args = append(args, fmt.Sprintf("https://www.youtube.com/watch?v=%s", id))

	cmd := exec.Command(ytDlp, args...)
	if err := cmd.Run(); err != nil {
		log.Printf("Download error for %s: %v", id, err)
		http.Error(w, fmt.Sprintf(`{"success":false,"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	matches, _ := filepath.Glob(filepath.Join(musicDir, fmt.Sprintf("%s.*", id)))
	var localFile string
	for _, m := range matches {
		if filepath.Ext(m) != ".json" {
			localFile = m
			break
		}
	}
	if localFile == "" {
		localFile = filepath.Join(musicDir, fmt.Sprintf("%s.m4a", id))
	}

	track := Track{
		ID:           id,
		Title:        title,
		Artist:       artist,
		Image:        image,
		OfflinePath:  localFile,
		IsDownloaded: true,
	}

	manifest := getManifest()
	var updated []Track
	for _, t := range manifest {
		if t.ID != id {
			updated = append(updated, t)
		}
	}
	updated = append(updated, track)
	_ = saveManifest(updated)

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"track":   track,
	})
}

func handleDownloads(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		json.NewEncoder(w).Encode(getManifest())
		return
	}

	if r.Method == http.MethodPost {
		var tracks []Track
		if err := json.NewDecoder(r.Body).Decode(&tracks); err != nil {
			http.Error(w, `{"success":false,"error":"invalid json"}`, http.StatusBadRequest)
			return
		}
		if err := saveManifest(tracks); err != nil {
			http.Error(w, fmt.Sprintf(`{"success":false,"error":"%s"}`, err.Error()), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
		return
	}
}

func handleDownloadsDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, `{"success":false,"error":"Missing id"}`, http.StatusBadRequest)
		return
	}

	manifest := getManifest()
	var updated []Track
	for _, t := range manifest {
		if t.ID != req.ID {
			updated = append(updated, t)
		}
	}
	_ = saveManifest(updated)

	matches, _ := filepath.Glob(filepath.Join(musicDir, fmt.Sprintf("%s.*", req.ID)))
	for _, m := range matches {
		if filepath.Ext(m) != ".json" {
			_ = os.Remove(m)
		}
	}

	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "healthy",
		"timestamp": time.Now().Unix(),
		"cookies":   cookiesFile != "",
	})
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	cacheMu.RLock()
	searchEntries := len(searchCache)
	streamEntries := len(streamCache)
	cacheMu.RUnlock()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"searchCacheEntries": searchEntries,
		"streamCacheEntries": streamEntries,
		"maxConcurrentProc":  cap(procSem),
		"cookiesConfigured":  cookiesFile != "",
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", corsMiddleware(handleRoot))
	mux.HandleFunc("/health", corsMiddleware(handleHealth))
	mux.HandleFunc("/api/stats", corsMiddleware(handleStats))
	mux.HandleFunc("/search", corsMiddleware(handleSearch))
	mux.HandleFunc("/charts", corsMiddleware(handleCharts))
	mux.HandleFunc("/stream", corsMiddleware(handleStream))
	mux.HandleFunc("/api/get-url", corsMiddleware(handleGetURL))
	mux.HandleFunc("/download", corsMiddleware(handleDownload))
	mux.HandleFunc("/api/downloads", corsMiddleware(handleDownloads))
	mux.HandleFunc("/api/downloads/delete", corsMiddleware(handleDownloadsDelete))

	addr := fmt.Sprintf("127.0.0.1:%s", port)
	if os.Getenv("RENDER") != "" || os.Getenv("HOST") == "0.0.0.0" {
		addr = fmt.Sprintf("0.0.0.0:%s", port)
	}
	log.Printf("[Horizon Backend] Go proxy server starting on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
