FROM oven/bun:1 as base

# Install Python, curl, and yt-dlp
RUN apt-get update && apt-get install -y python3 curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Set up app directory and permissions for Hugging Face (often runs as user 1000)
WORKDIR /app
RUN chown -R 1000:1000 /app

COPY package*.json ./
# Install dependencies if package.json exists
RUN bun install || true 

COPY youtube-proxy.js ./

# Hugging Face Spaces require port 7860
EXPOSE 7860
ENV PORT=7860

CMD ["bun", "run", "youtube-proxy.js"]
