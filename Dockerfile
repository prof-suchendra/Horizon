FROM oven/bun:1 as base

# Install Python and yt-dlp
RUN apt-get update && apt-get install -y python3 curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
# If package.json doesn't exist or is empty, this will gracefully continue
RUN bun install || true 
COPY youtube-proxy.js ./

EXPOSE 8000
ENV PORT=8000

CMD ["bun", "run", "youtube-proxy.js"]
