# API Reference

All endpoints are served from the same Express server on the configured `PORT` (default `3000`). Responses are JSON unless noted otherwise.

---

## Health

### `GET /health`

Basic health check for load balancers.

**Response**

```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "service": "musicflow-api"
}
```

### `GET /api/health`

Extended health check. Includes whether the yt-dlp binary has been resolved.

**Response**

```json
{
  "app": "musicflow",
  "status": "ok",
  "port": 3000,
  "pid": 12345,
  "uptime": 3600,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "ytDlpReady": true
}
```

---

## Search

### `GET /api/search?q=<query>`

Search for tracks. Returns up to 15 results. Results are cached for 30 minutes.

| Param | Type | Required | Description |
|:---|:---|:---|:---|
| `q` | string | yes | Search query (max 160 characters) |

**Response:** Array of track objects.

```json
[
  {
    "id": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "channel": "Rick Astley",
    "duration": 213,
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "views": 1500000000
  }
]
```

### `GET /api/smart-search?q=<query>&official=<0|1>`

Returns the single best match for a query, ranked by an internal scoring algorithm that favours official uploads and major labels.

| Param | Type | Required | Description |
|:---|:---|:---|:---|
| `q` | string | yes | Search query |
| `official` | `0` or `1` | no | Whether to prefer official channels (default `1`) |

**Response**

```json
{
  "query": "Shape of You",
  "bestMatch": { "id": "...", "title": "...", "channel": "...", "duration": 0, "thumbnail": "...", "views": 0 },
  "score": 1250,
  "candidates": [ /* top 3 results */ ]
}
```

**Errors:** `404` if no match found.

### `POST /api/batch-search`

Resolve multiple queries in parallel (up to 40, concurrency 4).

**Body**

```json
{
  "queries": ["Shape of You", "Blinding Lights", "Levitating"],
  "preferOfficial": true
}
```

**Response**

```json
{
  "total": 3,
  "found": 3,
  "results": [
    { "query": "Shape of You", "song": { /* track object */ }, "candidates": [ /* ... */ ] }
  ]
}
```

### `GET /api/suggestions?q=<query>`

Lightweight autocomplete. Returns up to 5 results (id, title, channel only).

---

## Track Info

### `GET /api/info/:videoId`

Fetch metadata for a single track.

**Response**

```json
{
  "id": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "channel": "Rick Astley",
  "duration": 213,
  "thumbnail": "https://...",
  "views": 1500000000,
  "description": "..."
}
```

---

## Streaming

### `GET /api/stream/:videoId?quality=<low|high>`

Proxied audio stream. The server extracts the audio URL via yt-dlp and proxies the bytes to the client.

| Param | Type | Default | Description |
|:---|:---|:---|:---|
| `quality` | `low` or `high` | `high` | `low` selects the smallest audio; `high` selects the best |

**Response:** Binary audio stream (`audio/mp4`, `audio/webm`, or `audio/mpeg`) with appropriate `Content-Type` and `Content-Length` headers. Supports `Range` requests for seeking.

**Fallback tiers:**

1. Direct URL extraction → proxy the audio bytes
2. Stdout pipe — yt-dlp streams audio to stdout, server pipes it to the response
3. Third-party API fallback

---

## Lyrics

### `GET /api/lyrics/:videoId`

Fetch lyrics from subtitle/caption tracks.

**Response**

```json
{
  "title": "Shape of You",
  "artist": "Ed Sheeran",
  "synced": true,
  "lines": [
    { "time": 4.5, "text": "The club isn't the best place to find a lover" },
    { "time": 8.2, "text": "So the bar is where I go" }
  ]
}
```

When `synced` is `true`, each line has a `time` (seconds) for synchronised display. When `false`, `time` is `0` and the text is unsynced.

---

## Downloads

### `GET /api/download/:videoId?title=<hint>&artist=<hint>`

Download a single track as a 192 kbps MP3. Rate-limited to 3 concurrent downloads.

| Param | Type | Required | Description |
|:---|:---|:---|:---|
| `title` | string | no | Filename hint (used if yt-dlp metadata fetch fails) |
| `artist` | string | no | Artist hint for the filename |

**Response:** Binary `audio/mpeg` stream with `Content-Disposition: attachment`.

**Errors:**

- `429` — too many concurrent downloads
- `500` — transcoding failed

### `POST /api/playlist-download`

Start an async playlist download job. Tracks are transcoded to MP3 and packaged into a ZIP archive.

**Body**

```json
{
  "name": "My Playlist",
  "tracks": [
    { "id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up", "artist": "Rick Astley" },
    { "id": "...", "title": "...", "artist": "..." }
  ]
}
```

- Maximum 50 tracks per job
- Only one playlist job can run at a time
- Non-YouTube IDs are silently skipped

**Response**

```json
{
  "jobId": "pl_1700000000000_abc123",
  "total": 10,
  "skipped": 2
}
```

### `GET /api/playlist-download/:jobId`

Poll job progress.

**Response**

```json
{
  "jobId": "pl_...",
  "status": "downloading",
  "total": 10,
  "completed": 4,
  "failed": 1,
  "failedTitles": ["Track That Failed"],
  "current": "Currently Downloading Track",
  "error": null,
  "size": 0
}
```

Status values: `queued` → `downloading` → `zipping` → `ready` → `downloaded`. Also `error` or `cancelled`.

### `POST /api/playlist-download/:jobId/cancel`

Cancel a running or completed job. Cleans up temporary files.

### `GET /api/playlist-download/:jobId/file`

Download the finished ZIP archive. Only available when status is `ready` or `downloaded`.

**Response:** Binary `application/zip` stream with `Content-Disposition: attachment`.

---

## Recommendations

### `GET /api/recommendations?seedArtists=<csv>&seedQueries=<csv>`

Get recommended tracks based on seed artists and/or queries. Falls back to trending/popular if no seeds are provided.

| Param | Type | Required | Description |
|:---|:---|:---|:---|
| `seedArtists` | comma-separated | no | Up to 3 artist names |
| `seedQueries` | comma-separated | no | Up to 2 track/query strings |

**Response:** Array of up to 24 track objects (shuffled, deduplicated, filtered to 1–10 min duration).

---

## Mood Mix

### `POST /api/mood-mix`

Generate a mood-based mix from multiple search queries.

**Body**

```json
{
  "queries": ["chill vibes", "rainy day songs"],
  "energy": 2
}
```

| Field | Type | Description |
|:---|:---|:---|
| `queries` | string[] | Up to 6 mood/genre queries |
| `energy` | number (0–4) | Low energy prefers longer tracks; high energy prefers shorter |

**Response**

```json
{
  "total": 48,
  "results": [ /* up to 20 track objects, scored and shuffled */ ]
}
```

---

## User Data

### `GET /api/user-data`

Read stored user preferences, playlists, and history.

**Response:** The full contents of `data/userData.json` as a JSON object. Returns `{}` if no data exists.

### `POST /api/user-data`

Merge a partial update into stored user data. The body is shallow-merged with the existing data; keys not present in the body are preserved.

**Body:** Any JSON object.

**Response**

```json
{ "success": true, "lastSaved": "2025-01-01T00:00:00.000Z" }
```

Writes are serialised (no race conditions) and use atomic file rename to prevent corruption.

---

## Network Info

### `GET /api/network-info`

Returns the server's network addresses — useful for connecting from other devices.

**Response**

```json
{
  "port": 3000,
  "isCloud": false,
  "cloudUrl": null,
  "localUrl": "http://localhost:3000",
  "ips": ["192.168.1.42"],
  "networkUrls": ["http://192.168.1.42:3000"],
  "primaryNetworkUrl": "http://192.168.1.42:3000"
}
```

---

## Caching

All search-related endpoints (`/api/search`, `/api/smart-search`, `/api/suggestions`, `/api/recommendations`) use an in-memory LRU cache with a 30-minute TTL and a 500-entry cap.

---

## Error Format

All error responses follow this shape:

```json
{ "error": "Human-readable error message" }
```

Unknown `/api/*` paths return `404` with:

```json
{ "error": "Unknown API endpoint: GET /api/nonexistent" }
```
