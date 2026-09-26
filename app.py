from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import yt_dlp
import httpx
import os
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

yt = YTMusic()
DOWNLOAD_DIR = os.path.expanduser("~/Music/Horizon")
MANIFEST_PATH = os.path.join(DOWNLOAD_DIR, "downloads.json")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Shared yt-dlp options configured to bypass YouTube cloud bot detection
YDL_EXTRACTOR_ARGS = {
    'youtube': {
        'player_client': ['android', 'ios', 'mweb'],
        'player_skip': ['webpage', 'configs', 'js'],
    }
}

def get_cookie_file():
    # 1. Render Secret File feature (/etc/secrets/cookies.txt)
    render_secret_path = "/etc/secrets/cookies.txt"
    if os.path.exists(render_secret_path):
        return render_secret_path

    # 2. Base64-encoded environment variable (YOUTUBE_COOKIES_BASE64)
    b64_cookies = os.environ.get("YOUTUBE_COOKIES_BASE64")
    if b64_cookies and b64_cookies.strip():
        import base64
        tmp_cookie_path = "/tmp/youtube_cookies.txt"
        try:
            decoded = base64.b64decode(b64_cookies.strip()).decode("utf-8")
            with open(tmp_cookie_path, "w", encoding="utf-8") as f:
                f.write(decoded)
            return tmp_cookie_path
        except Exception as e:
            print("Failed to decode YOUTUBE_COOKIES_BASE64:", e)

    # 3. Plain environment variable YOUTUBE_COOKIES
    env_cookies = os.environ.get("YOUTUBE_COOKIES")
    if env_cookies and env_cookies.strip():
        tmp_cookie_path = "/tmp/youtube_cookies.txt"
        try:
            with open(tmp_cookie_path, "w", encoding="utf-8") as f:
                f.write(env_cookies.strip())
            return tmp_cookie_path
        except Exception:
            pass
    
    # 4. Local cookies file in project root
    for candidate in ["cookies.txt", "www.youtube.com_cookies.txt"]:
        if os.path.exists(candidate):
            return candidate
    return None

def get_ydl_opts(extra_opts=None):
    opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'quiet': True,
        'no_warnings': True,
        'extractor_args': YDL_EXTRACTOR_ARGS,
    }
    cfile = get_cookie_file()
    if cfile:
        opts['cookiefile'] = cfile
    if extra_opts:
        opts.update(extra_opts)
    return opts

@app.api_route("/search", methods=["GET", "HEAD"])
def search(q: str):
    try:
        results = yt.search(q, filter="songs")
        mapped = []
        for r in results:
            mapped.append({
                "id": r.get("videoId"),
                "title": r.get("title"),
                "artist": r.get("artists", [{}])[0].get("name", "Unknown") if r.get("artists") else "Unknown",
                "image": r.get("thumbnails", [{}])[-1].get("url", "") if r.get("thumbnails") else ""
            })
        return JSONResponse(content={"results": mapped})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.api_route("/charts", methods=["GET", "HEAD"])
def charts():
    try:
        charts_data = yt.get_charts(country="IN")
        playlist_id = charts_data.get("videos", [{}])[0].get("playlistId")
        if not playlist_id:
            return JSONResponse(content={"results": []})
        playlist = yt.get_playlist(playlist_id)
        songs = playlist.get("tracks", [])
        mapped = []
        for r in songs:
            mapped.append({
                "id": r.get("videoId"),
                "title": r.get("title"),
                "artist": r.get("artists", [{}])[0].get("name", "Unknown") if r.get("artists") else "Unknown",
                "image": r.get("thumbnails", [{}])[-1].get("url", "") if r.get("thumbnails") else ""
            })
        return JSONResponse(content={"results": mapped})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.api_route("/api/get-url", methods=["GET", "HEAD"])
def get_url(id: str):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    ydl_opts = get_ydl_opts({'simulate': True})
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={id}", download=False)
            return JSONResponse(content={"url": info.get("url")})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.api_route("/stream", methods=["GET", "HEAD"])
async def stream(id: str, request: Request):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    
    ydl_opts = get_ydl_opts({'simulate': True})
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={id}", download=False)
            media_url = info.get("url")
            
        if not media_url:
            return JSONResponse(content={"error": "Stream URL could not be resolved"}, status_code=500)
        
        if request.method == "HEAD":
            return JSONResponse(content={"status": "ready"})
            
        # Stream the audio chunks directly through proxy
        client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
        req_headers = {}
        if "range" in request.headers:
            req_headers["Range"] = request.headers["range"]
            
        audio_req = client.build_request("GET", media_url, headers=req_headers)
        audio_res = await client.send(audio_req, stream=True)
        
        async def stream_generator():
            try:
                async for chunk in audio_res.aiter_bytes():
                    yield chunk
            finally:
                await audio_res.aclose()
                await client.aclose()
                
        response_headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": audio_res.headers.get("content-type", "audio/mp4"),
            "Access-Control-Allow-Origin": "*",
        }
        if "content-length" in audio_res.headers:
            response_headers["Content-Length"] = audio_res.headers["content-length"]
        if "content-range" in audio_res.headers:
            response_headers["Content-Range"] = audio_res.headers["content-range"]
            
        return StreamingResponse(
            stream_generator(),
            status_code=audio_res.status_code,
            headers=response_headers,
            media_type=audio_res.headers.get("content-type", "audio/mp4")
        )
    except Exception as e:
        return JSONResponse(content={"error": f"Extraction failed: {str(e)}"}, status_code=500)

@app.api_route("/download", methods=["GET", "HEAD"])
def download(id: str, title: str = "", artist: str = "", image: str = "", saveOffline: bool = True):
    if not id:
        return JSONResponse(content={"success": False, "error": "Missing id"}, status_code=400)
    
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    out_template = os.path.join(DOWNLOAD_DIR, f"{id}.%(ext)s")
    
    ydl_opts = get_ydl_opts({'outtmpl': out_template})
    
    try:
        existing_file = None
        for ext in ['m4a', 'webm', 'mp3', 'opus', 'aac']:
            fpath = os.path.join(DOWNLOAD_DIR, f"{id}.{ext}")
            if os.path.exists(fpath):
                existing_file = fpath
                break
        
        if not existing_file:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={id}"])
            for ext in ['m4a', 'webm', 'mp3', 'opus', 'aac']:
                fpath = os.path.join(DOWNLOAD_DIR, f"{id}.{ext}")
                if os.path.exists(fpath):
                    existing_file = fpath
                    break
        
        file_path = existing_file or os.path.join(DOWNLOAD_DIR, f"{id}.m4a")
        
        track_obj = {
            "id": id,
            "title": title or "Unknown Track",
            "artist": artist or "Unknown Artist",
            "image": image or "",
            "isDownloaded": True,
            "offlinePath": file_path,
            "streamUrl": f"http://localhost:8000/offline-stream?id={id}"
        }
        
        downloads = []
        if os.path.exists(MANIFEST_PATH):
            try:
                with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                    downloads = json.load(f)
            except Exception:
                downloads = []
        
        downloads = [d for d in downloads if d.get("id") != id]
        downloads.append(track_obj)
        with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
            json.dump(downloads, f, indent=2)
            
        return JSONResponse(content={"success": True, "track": track_obj})
    except Exception as e:
        return JSONResponse(content={"success": False, "error": str(e)}, status_code=500)

@app.api_route("/offline-stream", methods=["GET", "HEAD"])
def offline_stream(id: str):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    for ext in ['m4a', 'webm', 'mp3', 'opus', 'aac']:
        fpath = os.path.join(DOWNLOAD_DIR, f"{id}.{ext}")
        if os.path.exists(fpath):
            return FileResponse(fpath)
    return JSONResponse(content={"error": "File not found"}, status_code=404)

@app.api_route("/api/downloads", methods=["GET", "HEAD"])
def get_downloads():
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                return JSONResponse(content=json.load(f))
        except Exception:
            return JSONResponse(content=[])
    return JSONResponse(content=[])

@app.post("/api/downloads")
async def save_downloads(request: Request):
    try:
        data = await request.json()
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.post("/api/downloads/delete")
async def delete_download(request: Request):
    try:
        data = await request.json()
        track_id = data.get("id")
        if not track_id:
            return JSONResponse(content={"error": "Missing id"}, status_code=400)
        
        for ext in ['m4a', 'webm', 'mp3', 'opus', 'aac']:
            fpath = os.path.join(DOWNLOAD_DIR, f"{track_id}.{ext}")
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except Exception:
                    pass
        
        if os.path.exists(MANIFEST_PATH):
            try:
                with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                    downloads = json.load(f)
                downloads = [d for d in downloads if d.get("id") != track_id]
                with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
                    json.dump(downloads, f, indent=2)
            except Exception:
                pass
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.api_route("/", methods=["GET", "HEAD"])
def read_root():
    return {"message": "Horizon Python Proxy Online"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
