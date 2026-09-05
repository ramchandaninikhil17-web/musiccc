#!/usr/bin/env bash
# End-to-end check of the single-track VIDEO download path (/api/download?format=video).
#
# Proves the fix for "video download only gives audio": a real source yields an
# mp4 that actually contains a video stream, an audio-only source is flagged via
# X-Video-Available:false instead of being passed off as video, and audio
# downloads are unaffected.
#
# Needs a real ffmpeg + ffprobe to synthesise/inspect media; skips cleanly if
# neither is on PATH. No network, isolated /tmp copy, never touches your data/.
set -u

SRC="$(cd "$(dirname "$0")/.." && pwd)"
RUN=/tmp/mf-vtest
PORT=3893
FAILURES=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1${2:+ — $2}"; FAILURES=$((FAILURES+1)); }
check() { if [ "$1" = "1" ]; then pass "$2"; else fail "$2" "${3:-}"; fi; }

FF="$(command -v ffmpeg || true)"
FP="$(command -v ffprobe || true)"
if [ -z "$FF" ] || [ -z "$FP" ]; then
  echo "  SKIP  video-download suite (ffmpeg/ffprobe not on PATH)"
  exit 0
fi

rm -rf "$RUN"; mkdir -p "$RUN/data"
cp "$SRC/server.js" "$SRC/package.json" "$RUN/"
cp -r "$SRC/lib" "$SRC/public" "$RUN/"
ln -s "$SRC/node_modules" "$RUN/node_modules"
cp "$SRC/test/fixtures/smart-yt-dlp.sh" "$RUN/yt-dlp"; chmod +x "$RUN/yt-dlp"

cd "$RUN"
SMART_FFMPEG="$FF" FFMPEG_PATH="$FF" FAKE_NOVIDEO_IDS=NOVIDEOAAA1 \
  FAKE_HEIGHT_MAP="ONLY720AAA1=720" FAKE_STALE_IDS=STALE4K0001 NODE_ENV=test PORT=$PORT \
  node server.js > /tmp/mf-vtest.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -sf "localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "localhost:$PORT/api/health" >/dev/null 2>&1 \
  && pass "server is up" || { fail "server never came up"; cat /tmp/mf-vtest.log; exit 1; }

echo
echo "Server advertises video capability"
vd=$(curl -s "localhost:$PORT/api/health" | tr -d " " | grep -o '"videoDownload":true' | head -1)
check "$([ -n "$vd" ] && echo 1)" "/api/health reports videoDownload:true" "got: $vd"

get() { curl -s -D "$2" "localhost:$PORT$1" -o "$3"; }
header() { grep -i "^$2" "$1" | tr -d '\r' | head -1; }
val() { header "$1" "$2" | awk '{print $2}'; }
streams() { "$FP" -v error -show_entries stream=codec_type -of csv=p=0 "$1" | tr '\n' ','; }
vheight() { "$FP" -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$1" | tr -d '\r\n'; }

echo
echo "Server config: no explicit player_client override (yt-dlp uses its default)"
# As of mid-2026 YouTube gates android, web, tv and ios player clients behind
# PO tokens / SOCS cookies. Specifying any of them without a token causes
# "The page needs to be reloaded" or a degraded 360p-only ladder. yt-dlp's
# default client (currently visionos) returns the full DASH ladder without
# tokens. The server must NOT set an explicit player_client override.
has_override=$(grep -c 'player_client=' "$SRC/server.js" | tr -d '\r')
# Only comments should mention player_client, never actual args arrays.
active_override=$(awk '/^[[:space:]]*(const|let|var).*YTDLP_ARGS/,/\]/' "$SRC/server.js" \
  | grep -c 'player_client=' | tr -d '\r')
check "$([ "$active_override" = "0" ] && echo 1)" \
  "no explicit player_client in YTDLP_ARGS (yt-dlp uses default)" "active_overrides=$active_override"

echo
echo "Real video source"
get "/api/download/dQw4w9WgXcQ?format=video&quality=720&title=Song" /tmp/v1.h /tmp/v1.bin
ct=$(val /tmp/v1.h content-type); xv=$(val /tmp/v1.h x-video-available); s1=$(streams /tmp/v1.bin)
check "$([ "$ct" = "video/mp4" ] && echo 1)" "served as video/mp4" "ct=$ct"
check "$([ "$xv" = "true" ] && echo 1)" "X-Video-Available: true" "xv=$xv"
check "$(echo "$s1" | grep -q video && echo 1)" "file actually contains a video stream" "streams=$s1"
check "$(echo "$s1" | grep -q audio && echo 1)" "file also contains audio" "streams=$s1"
check "$(grep -iq 'filename=.*\.mp4' /tmp/v1.h && echo 1)" "Content-Disposition names a .mp4"

echo
echo "Audio-only source, video requested (the bug)"
get "/api/download/NOVIDEOAAA1?format=video&quality=1080&title=Topic" /tmp/v2.h /tmp/v2.bin
xv2=$(val /tmp/v2.h x-video-available); s2=$(streams /tmp/v2.bin)
check "$([ "$xv2" = "false" ] && echo 1)" "flagged X-Video-Available: false" "xv=$xv2"
if echo "$s2" | grep -q video; then hasv=0; else hasv=1; fi
check "$hasv" "no video stream present (honestly reported, not faked)" "streams=$s2"
check "$(echo "$s2" | grep -q audio && echo 1)" "audio is still delivered" "streams=$s2"

echo
echo "Audio download unaffected"
get "/api/download/dQw4w9WgXcQ?format=audio&quality=192&title=Song" /tmp/v3.h /tmp/v3.bin
ct3=$(val /tmp/v3.h content-type); s3=$(streams /tmp/v3.bin)
check "$([ "$ct3" = "audio/mpeg" ] && echo 1)" "served as audio/mpeg" "ct=$ct3"
check "$(echo "$s3" | grep -q audio && echo 1)" "contains audio" "streams=$s3"
check "$(grep -iq 'filename=.*\.mp3' /tmp/v3.h && echo 1)" "Content-Disposition names a .mp3"

echo
echo "Available resolutions endpoint (/api/formats)"
curl -s "localhost:$PORT/api/formats/dQw4w9WgXcQ" -o /tmp/f1.json
fmax=$(tr -d ' ' < /tmp/f1.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
fhas=$(tr -d ' ' < /tmp/f1.json | grep -o '"hasVideo":true' | head -1)
check "$([ "$fmax" = "2160" ] && echo 1)" "4K track reports maxHeight 2160" "maxHeight=$fmax"
check "$([ -n "$fhas" ] && echo 1)" "4K track reports hasVideo:true"
check "$(grep -q '2160' /tmp/f1.json && grep -q '720' /tmp/f1.json && echo 1)" "ladder includes 720 and 2160"

curl -s "localhost:$PORT/api/formats/ONLY720AAA1" -o /tmp/f2.json
f2max=$(tr -d ' ' < /tmp/f2.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
check "$([ "$f2max" = "720" ] && echo 1)" "720-capped track reports maxHeight 720" "maxHeight=$f2max"
check "$(tr -d ' ' < /tmp/f2.json | grep -q '"heights":\[.*720\]' && echo 1)" "capped ladder tops out at 720" "$(cat /tmp/f2.json)"
check "$(grep -q '1080' /tmp/f2.json && echo 0 || echo 1)" "capped ladder omits 1080+"

curl -s "localhost:$PORT/api/formats/NOVIDEOAAA1" -o /tmp/f3.json
f3has=$(tr -d ' ' < /tmp/f3.json | grep -o '"hasVideo":false' | head -1)
f3max=$(tr -d ' ' < /tmp/f3.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
check "$([ -n "$f3has" ] && echo 1)" "audio-only track reports hasVideo:false"
check "$([ "$f3max" = "0" ] && echo 1)" "audio-only track reports maxHeight 0" "maxHeight=$f3max"

echo
echo "Resolution is honored exactly when available (720 on a 4K track)"
get "/api/download/dQw4w9WgXcQ?format=video&quality=720&title=Song" /tmp/r1.h /tmp/r1.bin
r1h=$(vheight /tmp/r1.bin); r1hdr=$(val /tmp/r1.h x-video-height); r1req=$(val /tmp/r1.h x-video-requested)
check "$([ "$r1h" = "720" ] && echo 1)" "file is actually 720p" "height=$r1h"
check "$([ "$r1hdr" = "720" ] && echo 1)" "X-Video-Height: 720" "hdr=$r1hdr"
check "$([ "$r1req" = "720" ] && echo 1)" "X-Video-Requested echoes 720" "req=$r1req"

echo
echo "4K request on a 4K track delivers 2160p"
get "/api/download/dQw4w9WgXcQ?format=video&quality=2160&title=Song" /tmp/r2.h /tmp/r2.bin
r2h=$(vheight /tmp/r2.bin); r2hdr=$(val /tmp/r2.h x-video-height)
check "$([ "$r2h" = "2160" ] && echo 1)" "file is actually 2160p" "height=$r2h"
check "$([ "$r2hdr" = "2160" ] && echo 1)" "X-Video-Height: 2160" "hdr=$r2hdr"

echo
echo "2K requested but track maxes at 720 (the reported bug: picked 2K, got low)"
get "/api/download/ONLY720AAA1?format=video&quality=1440&title=Song" /tmp/r3.h /tmp/r3.bin
r3h=$(vheight /tmp/r3.bin); r3hdr=$(val /tmp/r3.h x-video-height); r3req=$(val /tmp/r3.h x-video-requested)
check "$([ "$r3h" = "720" ] && echo 1)" "capped to the real best (720p), not a 360p fallback" "height=$r3h"
check "$([ "$r3hdr" = "720" ] && echo 1)" "X-Video-Height reports the true 720" "hdr=$r3hdr"
check "$([ "$r3req" = "1440" ] && echo 1)" "X-Video-Requested preserves the 1440 ask" "req=$r3req"

echo
echo "4K is visible AND downloadable via the default client (no PO token needed)"
# The server uses yt-dlp's default client (no explicit player_client override),
# which returns the full DASH ladder. /api/formats must report the real 4K
# ceiling so available == downloadable.
curl -s "localhost:$PORT/api/formats/dQw4w9WgXcQ" -o /tmp/f4.json
f4max=$(tr -d ' ' < /tmp/f4.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
check "$([ "$f4max" = "2160" ] && echo 1)" "/api/formats reports 2160 (full ladder via default client)" "maxHeight=$f4max"

# ...and a 4K request downloads a real 2160p file: the clamp must not cap it to 360.
get "/api/download/dQw4w9WgXcQ?format=video&quality=2160&title=Song" /tmp/r4.h /tmp/r4.bin
r4h=$(vheight /tmp/r4.bin); r4hdr=$(val /tmp/r4.h x-video-height)
check "$([ "$r4h" = "2160" ] && echo 1)" "4K request yields a real 2160p file, not a 360p clamp" "height=$r4h"
check "$([ "$r4hdr" = "2160" ] && echo 1)" "X-Video-Height: 2160" "hdr=$r4hdr"

echo
echo "Stale downloader recovery (one-click update, no restart)"
# The exact bug the user reported: EVERY resolution option downloads the same
# ~360p file. Root cause is a yt-dlp binary too old to see YouTube's current DASH
# ladder, so even the web client only exposes a 360p rung. STALE4K0001 is really a
# 4K track, but the (simulated) old binary caps it to 360 for all clients until
# `yt-dlp -U` runs. The fix must swap the binary live and clear the format cache,
# with no Node restart — because yt-dlp is invoked per request.

# Startup populated the version from the OLD binary.
hv1=$(curl -s "localhost:$PORT/api/health" | tr -d ' ' | grep -o '"ytDlpVersion":"[^"]*"' | head -1)
check "$(echo "$hv1" | grep -q '2020.01.01' && echo 1)" "/api/health reports the stale version before updating" "hv=$hv1"

# Before the update the 4K ladder is collapsed to 360 for every client.
curl -s "localhost:$PORT/api/formats/STALE4K0001" -o /tmp/s1.json
s1max=$(tr -d ' ' < /tmp/s1.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
check "$([ "$s1max" = "360" ] && echo 1)" "stale binary collapses the 4K ladder to 360p" "maxHeight=$s1max"

# ...so asking for 4K really does hand back a 360p file — the reported symptom.
get "/api/download/STALE4K0001?format=video&quality=2160&title=Song" /tmp/s1d.h /tmp/s1d.bin
s1dh=$(vheight /tmp/s1d.bin)
check "$([ "$s1dh" = "360" ] && echo 1)" "picking 4K on the stale binary downloads only 360p (the bug)" "height=$s1dh"

# One-click fix: update the downloader in place.
curl -s -X POST "localhost:$PORT/api/update-ytdlp" -o /tmp/upd.json
uok=$(tr -d ' ' < /tmp/upd.json | grep -o '"ok":true' | head -1)
uto=$(tr -d ' ' < /tmp/upd.json | grep -o '"to":"[^"]*"' | head -1)
check "$([ -n "$uok" ] && echo 1)" "POST /api/update-ytdlp reports ok:true" "resp=$(cat /tmp/upd.json)"
check "$(echo "$uto" | grep -q '2099.12.31' && echo 1)" "update swaps in the fresh build" "to=$uto"

# The ladder is restored on the very next probe (formatsCache was cleared).
curl -s "localhost:$PORT/api/formats/STALE4K0001" -o /tmp/s2.json
s2max=$(tr -d ' ' < /tmp/s2.json | grep -o '"maxHeight":[0-9]*' | grep -o '[0-9]*')
check "$([ "$s2max" = "2160" ] && echo 1)" "update restores the full 2160p ladder (cache cleared, no restart)" "maxHeight=$s2max"

# ...and 4K now downloads a real 2160p file.
get "/api/download/STALE4K0001?format=video&quality=2160&title=Song" /tmp/s2d.h /tmp/s2d.bin
s2dh=$(vheight /tmp/s2d.bin)
check "$([ "$s2dh" = "2160" ] && echo 1)" "4K downloads a real 2160p file after the update" "height=$s2dh"

# /api/health reflects the new version live.
hv2=$(curl -s "localhost:$PORT/api/health" | tr -d ' ' | grep -o '"ytDlpVersion":"[^"]*"' | head -1)
check "$(echo "$hv2" | grep -q '2099.12.31' && echo 1)" "/api/health reports the updated version immediately" "hv=$hv2"

echo
if [ "$FAILURES" = 0 ]; then echo "  video-download: ALL PASSED"; else echo "  video-download: $FAILURES CHECK(S) FAILED"; fi
exit $((FAILURES > 0))
