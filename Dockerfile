FROM python:3.11-slim

# Install system dependencies (ffmpeg is essential for yt-dlp audio extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend script
COPY app.py .

# Expose Render standard port
ENV PORT=8000
EXPOSE 8000

# Run uvicorn using dynamic PORT passed by Render
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
