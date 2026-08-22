#!/usr/bin/env bash
# Runs the whole MusicFlow test suite.
#
#   bash test/run-all.sh
#
# No network needed: the API and client tests boot an isolated copy of the app
# in /tmp with a stubbed yt-dlp, so nothing here touches your real downloads,
# your data/ folder, or the port your dev server runs on.

set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FAILED=0

run() {
  echo
  echo "=============================================================="
  echo "  $1"
  echo "=============================================================="
  shift
  "$@" || FAILED=$((FAILED+1))
}

run "ZIP writer (unit)"        node test/zip.test.js
run "DOM wiring (static)"      node test/dom-ids.test.js
run "Playlist remove (logic)"  node test/playlist-remove.test.js
run "Download API (end-to-end)" bash test/api-download.test.sh

# The client test drives the real app.js code against a real server, so it needs
# one running first.
echo
echo "=============================================================="
echo "  Client logic (end-to-end)"
echo "=============================================================="
RUN=/tmp/mf-client
PORT=3895
rm -rf "$RUN"; mkdir -p "$RUN/data"
cp "$ROOT/server.js" "$ROOT/package.json" "$RUN/"
cp -r "$ROOT/lib" "$ROOT/public" "$RUN/"
ln -s "$ROOT/node_modules" "$RUN/node_modules" 2>/dev/null || true
cp "$ROOT/test/fixtures/fake-yt-dlp.sh" "$RUN/yt-dlp"; chmod +x "$RUN/yt-dlp"

( cd "$RUN" && FAKE_FAIL_IDS=FAILFAILFA1 FAKE_DELAY_MS=500 PORT=$PORT \
    node server.js > /tmp/mf-client.log 2>&1 ) &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 40); do
  curl -sf "localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

TEST_PORT=$PORT node test/client-download.test.js || FAILED=$((FAILED+1))
kill $SRV 2>/dev/null

echo
echo "=============================================================="
if [ "$FAILED" = 0 ]; then
  echo "  ALL SUITES PASSED"
else
  echo "  $FAILED SUITE(S) FAILED"
fi
echo "=============================================================="
exit $((FAILED > 0))
