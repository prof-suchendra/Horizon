# Use the official Bun image
FROM oven/bun:1

# Install Python (required by yt-dlp) and curl
RUN apt-get update && apt-get install -y python3 curl && rm -rf /var/lib/apt/lists/*

# Download and install the latest yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# Set up the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lockb* ./
RUN bun install

# Copy all project files
COPY . .

# Ensure the download directory exists with correct permissions
RUN mkdir -p /app/Music/Horizon
RUN chmod -R 777 /app/Music

# Expose the port Koyeb will route to
EXPOSE 8000

# Start the proxy server
CMD ["bun", "run", "youtube-proxy.js"]
