from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import yt_dlp
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

@app.get("/search")
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

@app.get("/charts")
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

@app.get("/api/get-url")
def get_url(id: str):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'quiet': True,
        'no_warnings': True,
        'simulate': True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={id}", download=False)
            return JSONResponse(content={"url": info.get("url")})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)

@app.get("/stream")
def stream(id: str):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'quiet': True,
        'simulate': True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={id}", download=False)
            return RedirectResponse(info.get("url"))
    except Exception as e:
        return JSONResponse(content={"error": f"Extraction failed: {str(e)}"}, status_code=500)

@app.get("/download")
def download(id: str, title: str = "", artist: str = "", image: str = "", saveOffline: bool = True):
    if not id:
        return JSONResponse(content={"success": False, "error": "Missing id"}, status_code=400)
    
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    out_template = os.path.join(DOWNLOAD_DIR, f"{id}.%(ext)s")
    
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'outtmpl': out_template,
        'quiet': True,
        'no_warnings': True,
    }
    
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

@app.get("/offline-stream")
def offline_stream(id: str):
    if not id:
        return JSONResponse(content={"error": "Missing id"}, status_code=400)
    for ext in ['m4a', 'webm', 'mp3', 'opus', 'aac']:
        fpath = os.path.join(DOWNLOAD_DIR, f"{id}.{ext}")
        if os.path.exists(fpath):
            return FileResponse(fpath)
    return JSONResponse(content={"error": "File not found"}, status_code=404)

@app.get("/api/downloads")
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
