# Production Dockerfile for MusicFlow
FROM node:20-slim AS base

# Install system dependencies (curl, python3, ffmpeg for fallback)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    ca-certificates \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Run pre-build binary preparation (downloads Linux yt-dlp & sets chmod)
RUN node prepare-binaries.js

# Ensure data directory exists
RUN mkdir -p /app/data

# Expose default port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Start server
CMD ["node", "server.js"]
