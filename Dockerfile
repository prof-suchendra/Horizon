# Build Stage
FROM golang:1.23-alpine AS builder

WORKDIR /build

# Copy Go files and compile static binary
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o horizon-backend main.go

# Final Lightweight Runtime Stage
FROM alpine:3.20

# Install yt-dlp, python3, ffmpeg, nodejs, and ca-certificates
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    nodejs \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy compiled Go backend from builder stage
COPY --from=builder /build/horizon-backend /app/horizon-backend

# Create music directory
RUN mkdir -p /root/Music/Horizon

ENV PORT=8000
ENV RENDER=true
EXPOSE 8000

# Run the Go backend
CMD ["/app/horizon-backend"]
