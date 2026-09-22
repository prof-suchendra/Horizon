from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import yt_dlp
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

yt = YTMusic()

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
    except:
        return JSONResponse(content={"error": "Extraction failed"}, status_code=500)

@app.get("/")
def read_root():
    return {"message": "Horizon Python Proxy Online"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
