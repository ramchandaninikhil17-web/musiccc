#!/usr/bin/env bash
# Stand-in for yt-dlp used by the integration test. Parses the -o template the
# server passes and writes deterministic bytes to <prefix>.mp3, so the whole
# job -> zip -> download path can be exercised without network access.
#
# Behaviour hooks, driven by env vars set by the test:
#   FAKE_FAIL_IDS   comma-separated video ids that should fail outright
#   FAKE_EMPTY_IDS  comma-separated video ids that should produce a 0-byte file
#   FAKE_BIG_IDS    comma-separated video ids that produce a ~1 MB payload, for
#                   tests that need an archive too large to fit in a socket buffer
#   FAKE_DELAY_MS   per-invocation delay, used to observe in-flight progress

set -u

if [ "${1:-}" = "--version" ]; then
  echo "2099.01.01"
  exit 0
fi

out=""
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  case "$arg" in
    https://*) url="$arg" ;;
  esac
  prev="$arg"
done

# --dump-json probe: hand back a title so the single-track endpoint can name files.
for arg in "$@"; do
  if [ "$arg" = "--dump-json" ]; then
    echo '{"title":"Fake Track","channel":"Fake Channel"}'
    exit 0
  fi
done

vid="${url##*v=}"

if [ -n "${FAKE_DELAY_MS:-}" ]; then
  sleep "$(awk "BEGIN{print ${FAKE_DELAY_MS}/1000}")"
fi

case ",${FAKE_FAIL_IDS:-}," in
  *",$vid,"*) echo "ERROR: simulated failure for $vid" >&2; exit 1 ;;
esac

target="${out%.%(ext)s}.mp3"

case ",${FAKE_EMPTY_IDS:-}," in
  *",$vid,"*) : > "$target"; exit 0 ;;
esac

bytes=20000
case ",${FAKE_BIG_IDS:-}," in
  # Large enough that a stalled transfer cannot fit in the kernel's socket
  # buffers (tcp_wmem + tcp_rmem max out in the single-digit MB range), which is
  # what makes an interrupted download observable server-side at all.
  *",$vid,"*) bytes=24000000 ;;
esac

# Deterministic per-id payload so the test can verify the right bytes ended up
# under the right name inside the archive.
{
  printf 'FAKEMP3:%s:' "$vid"
  head -c "$bytes" /dev/zero | tr '\0' "$(printf '%s' "$vid" | cut -c1)"
} > "$target"

exit 0
