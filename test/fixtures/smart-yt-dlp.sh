#!/usr/bin/env bash
# Smart stand-in for yt-dlp used by the video-download suite. Unlike the audio
# fixture (which always writes .mp3), this honours the requested format AND the
# requested resolution, using the REAL ffmpeg (SMART_FFMPEG, default "ffmpeg") to
# synthesise a tiny valid media file — so the whole download -> verify -> serve
# path runs with actual streams and no network.
#
# It ALSO mimics YouTube's client-dependent format ladder: the android
# player_client (what BASE_YTDLP_ARGS asks for) only exposes a low progressive
# rung (~360p), while the web/tv clients (VIDEO_YTDLP_ARGS) expose the full DASH
# ladder up to 4K. That is the real trap behind "I can watch it in 4K on YouTube
# but the app says 360p is the best" — so the suite can prove the server
# enumerates formats with the web-first client, not the android one.
#
# Env hooks:
#   FAKE_NOVIDEO_IDS  comma ids that only have audio even when video is requested
#                     (simulates a "- Topic" upload) -> audio-only mp4, no video
#                     formats advertised in --dump-json
#   FAKE_FAIL_IDS     comma ids that fail outright
#   FAKE_HEIGHT_MAP   comma "videoId=maxHeight" pairs capping a track's ladder,
#                     e.g. "ONLY720AAA1=720". Unlisted ids default to 2160 (4K).
set -u
FF="${SMART_FFMPEG:-ffmpeg}"
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo .)"
MARKER="$SELF_DIR/.ytdlp-updated"

# Simulate `yt-dlp -U`: mark the binary as freshly updated and report success. It
# is what POST /api/update-ytdlp shells out to. After it runs, --version reports a
# newer build and FAKE_STALE_IDS stop being capped (the DASH ladder comes back).
case "${1:-}" in
  -U|--update|--update-to)
    : > "$MARKER" 2>/dev/null || true
    echo "Updating to stable@2099.12.31 ... Updated yt-dlp to stable@2099.12.31"
    exit 0 ;;
esac

# Version flips once the simulated update has run, so before != after is provable.
if [ "${1:-}" = "--version" ]; then
  if [ -f "$MARKER" ]; then echo "2099.12.31"; else echo "2020.01.01"; fi
  exit 0
fi

out=""; url=""; prev=""; is_extract_audio=0; is_dump=0; req_h=""; client_first=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  case "$arg" in
    https://*) url="$arg" ;;
    -x) is_extract_audio=1 ;;
    --dump-json) is_dump=1 ;;
    *player_client=*)
      # Which player_client is tried FIRST decides what ladder YouTube returns.
      # e.g. "youtube:player_client=android,web,tv" -> android
      client_first=$(printf '%s' "$arg" | sed -n 's/.*player_client=\([a-z_]*\).*/\1/p')
      ;;
    *height\<=*)
      # Pull the height cap the server put in the -f expression, e.g.
      # "bestvideo[height<=1080]+bestaudio/..." -> 1080 (first occurrence).
      req_h=$(printf '%s' "$arg" | grep -oE 'height<=[0-9]+' | head -1 | grep -oE '[0-9]+')
      ;;
  esac
  prev="$arg"
done

vid="${url##*v=}"
prefix="${out%.%(ext)s}"

case ",${FAKE_FAIL_IDS:-}," in *",$vid,"*) echo "ERROR: simulated failure for $vid" >&2; exit 1 ;; esac

# Does this id have no video at all?
novideo=0
case ",${FAKE_NOVIDEO_IDS:-}," in *",$vid,"*) novideo=1 ;; esac

# Per-id resolution ceiling (default 4K) — the true best the SOURCE offers.
max_h=2160
if [ -n "${FAKE_HEIGHT_MAP:-}" ]; then
  oldIFS="$IFS"; IFS=','
  for pair in $FAKE_HEIGHT_MAP; do
    k="${pair%%=*}"; v="${pair##*=}"
    if [ "$k" = "$vid" ] && [ -n "$v" ]; then max_h="$v"; fi
  done
  IFS="$oldIFS"
fi

# Effective ceiling for THIS request, given the player_client asked for. The
# android client under-reports to a single ~360p progressive rung on real
# YouTube; web/tv see the whole ladder. Anything that isn't android-first gets
# the full source ladder (fail-open, matching how VIDEO_YTDLP_ARGS behaves).
eff_max="$max_h"
if [ "$client_first" = "android" ] && [ "$eff_max" -gt 360 ]; then
  eff_max=360
fi

# Simulate a yt-dlp binary too old to extract YouTube's current DASH ladder:
# listed ids top out at 360p for EVERY client until an update has been applied
# (the marker written by `-U` above). This is the exact "every resolution option
# downloads the same low-res file" bug — and proves the update path clears it.
case ",${FAKE_STALE_IDS:-}," in
  *",$vid,"*)
    if [ ! -f "$MARKER" ] && [ "$eff_max" -gt 360 ]; then eff_max=360; fi
    ;;
esac

# 16:9 width for a given height; even dimensions (libx264 + yuv420p require it).
width_for() {
  case "$1" in
    144) echo 256 ;; 240) echo 426 ;; 360) echo 640 ;; 480) echo 854 ;;
    720) echo 1280 ;; 1080) echo 1920 ;; 1440) echo 2560 ;; 2160) echo 3840 ;;
    *) w=$(( $1 * 16 / 9 )); echo $(( w - (w % 2) )) ;;
  esac
}

if [ "$is_dump" = "1" ]; then
  # Advertise a real resolution ladder in the formats[] array so /api/formats and
  # the download-path clamp can read the true heights. An audio-only rung is always
  # present (vcodec:none) and must be ignored by the parser. The video rungs are
  # capped at eff_max, so an android-first dump only ever shows up to 360p.
  fmts='{"format_id":"140","vcodec":"none","acodec":"mp4a.40.2","height":null,"ext":"m4a"}'
  if [ "$novideo" = "0" ]; then
    for h in 144 240 360 480 720 1080 1440 2160; do
      if [ "$h" -le "$eff_max" ]; then
        fmts="${fmts},{\"format_id\":\"v${h}\",\"vcodec\":\"avc1.640028\",\"acodec\":\"none\",\"height\":${h},\"ext\":\"mp4\"}"
      fi
    done
  fi
  printf '{"title":"Rick Astley - Never Gonna Give You Up","channel":"RickAstleyVEVO","artist":"Rick Astley","duration":226,"formats":[%s]}\n' "$fmts"
  exit 0
fi

if [ "$is_extract_audio" = "1" ]; then
  "$FF" -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=1" \
    -c:a libmp3lame -q:a 4 "${prefix}.mp3" </dev/null
  exit $?
fi

if [ "$novideo" = "1" ]; then
  # audio-only track in an mp4 container (the exact bug being guarded against)
  "$FF" -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=1" \
    -c:a aac -movflags +faststart "${prefix}.mp4" </dev/null
  exit $?
fi

# Resolution actually produced: what the server asked for, capped to what THIS
# client can see. Mirrors real yt-dlp — you can never get more than the chosen
# client exposes, so an android-first video download tops out at 360p.
prod_h="${req_h:-$eff_max}"
if [ "$prod_h" -gt "$eff_max" ]; then prod_h="$eff_max"; fi
W=$(width_for "$prod_h")

# real H.264 video + AAC audio muxed to mp4 at the chosen resolution
"$FF" -hide_banner -loglevel error \
  -f lavfi -i "testsrc=size=${W}x${prod_h}:rate=10:duration=1" \
  -f lavfi -i "sine=frequency=440:duration=1" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "${prefix}.mp4" </dev/null
exit $?
