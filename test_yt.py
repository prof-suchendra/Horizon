from ytmusicapi import YTMusic
yt = YTMusic()
charts = yt.get_charts(country="IN")
playlistId = charts["videos"][0]["playlistId"]
playlist = yt.get_playlist(playlistId)
import json
print(json.dumps(playlist["tracks"][:1], indent=2))
