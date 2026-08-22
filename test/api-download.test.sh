#!/usr/bin/env bash
# End-to-end check of the playlist ZIP download job API.
#
# Runs against an isolated copy of the app in /tmp with a stubbed yt-dlp, so it
# needs no network and never touches the user's project folder.
set -u

SRC="$(cd "$(dirname "$0")/.." && pwd)"
RUN=/tmp/mf-itest
PORT=3891
FAILURES=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1${2:+ — $2}"; FAILURES=$((FAILURES+1)); }
check() { if [ "$1" = "1" ]; then pass "$2"; else fail "$2" "${3:-}"; fi; }

# ---- isolated copy -------------------------------------------------------
rm -rf "$RUN"; mkdir -p "$RUN"
cp "$SRC/server.js" "$SRC/package.json" "$RUN/"
cp -r "$SRC/lib" "$SRC/public" "$RUN/"
ln -s "$SRC/node_modules" "$RUN/node_modules"
mkdir -p "$RUN/data"
cp "$SRC/test/fixtures/fake-yt-dlp.sh" "$RUN/yt-dlp"
chmod +x "$RUN/yt-dlp"

cd "$RUN"
FAKE_FAIL_IDS=FAILFAILFA1 FAKE_EMPTY_IDS=EMPTYEMPTY1 FAKE_BIG_IDS=GGGGGGGGGG7 FAKE_DELAY_MS=350 \
  PORT=$PORT node server.js > /tmp/mf-itest.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -sf "localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "localhost:$PORT/api/health" >/dev/null 2>&1 \
  && pass "server is up" || { fail "server never came up"; cat /tmp/mf-itest.log; exit 1; }

api() { curl -s "localhost:$PORT$1"; }
post() { curl -s -X POST "localhost:$PORT$1" -H 'Content-Type: application/json' -d "$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "localhost:$PORT$2" ${3:+-H 'Content-Type: application/json' -d "$3"}; }

echo
echo "Validation"

c=$(code POST /api/playlist-download '{"name":"X","tracks":[]}')
check "$([ "$c" = 400 ] && echo 1)" "empty track list -> 400" "got $c"

c=$(code POST /api/playlist-download '{"name":"X","tracks":[{"id":"../../../etc/passwd"},{"id":"tooshort"},{"id":"has spaces!!"}]}')
check "$([ "$c" = 400 ] && echo 1)" "path traversal / malformed ids all rejected -> 400" "got $c"

c=$(code GET /api/playlist-download/does-not-exist)
check "$([ "$c" = 404 ] && echo 1)" "unknown job -> 404" "got $c"

c=$(code GET /api/playlist-download/does-not-exist/file)
check "$([ "$c" = 404 ] && echo 1)" "unknown job file -> 404" "got $c"

echo
echo "Happy path"

# 3 good, 1 that fails, 1 that yields an empty file, plus a duplicate id.
BODY='{"name":"My Mix / Test: 2024?","tracks":[
  {"id":"AAAAAAAAAA1","title":"First Song"},
  {"id":"BBBBBBBBBB2","title":"Second: Song?"},
  {"id":"AAAAAAAAAA1","title":"First Song Again"},
  {"id":"FAILFAILFA1","title":"Broken Song"},
  {"id":"EMPTYEMPTY1","title":"Empty Song"},
  {"id":"CCCCCCCCCC3","title":"गाना तीन"}
]}'
START=$(post /api/playlist-download "$BODY")
JOB=$(echo "$START" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
TOTAL=$(echo "$START" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')
check "$([ -n "$JOB" ] && echo 1)" "job started" "$START"
check "$([ "$TOTAL" = 5 ] && echo 1)" "duplicate id de-duplicated (total 5, not 6)" "total=$TOTAL"

# A second job while one is running must be refused.
c=$(code POST /api/playlist-download '{"name":"Other","tracks":[{"id":"DDDDDDDDDD4"}]}')
check "$([ "$c" = 409 ] && echo 1)" "concurrent second job -> 409" "got $c"

# Archive must not be served before it is ready.
c=$(code GET "/api/playlist-download/$JOB/file")
check "$([ "$c" = 409 ] && echo 1)" "file requested too early -> 409" "got $c"

# Progress should actually move while work is in flight.
sleep 0.6
MID=$(api "/api/playlist-download/$JOB")
echo "$MID" | grep -q '"status":"downloading"' \
  && pass "status reports downloading while in flight" \
  || fail "expected downloading status" "$MID"

for i in $(seq 1 60); do
  S=$(api "/api/playlist-download/$JOB")
  echo "$S" | grep -qE '"status":"(ready|error|cancelled)"' && break
  sleep 0.5
done
echo "  final status: $S"

echo "$S" | grep -q '"status":"ready"' && pass "job reached ready" || fail "job did not reach ready" "$S"
echo "$S" | grep -q '"completed":3' && pass "3 tracks completed" || fail "expected completed=3" "$S"
echo "$S" | grep -q '"failed":2' && pass "2 tracks recorded as failed (hard fail + empty file)" || fail "expected failed=2" "$S"
echo "$S" | grep -q 'Broken Song' && pass "failed titles reported back" || fail "expected failed titles" "$S"

echo
echo "Archive delivery"

HDRS=$(curl -s -D - -o /tmp/mf-itest.zip "localhost:$PORT/api/playlist-download/$JOB/file")
echo "$HDRS" | grep -qi 'content-type: application/zip' \
  && pass "served as application/zip" || fail "wrong content-type" "$(echo "$HDRS" | head -5)"
echo "$HDRS" | grep -qi "filename\*=UTF-8''" \
  && pass "RFC 5987 filename present" || fail "missing filename*" "$(echo "$HDRS" | grep -i disposition)"
# buildSafeFilename drops the illegal / : ? characters and then collapses the
# runs of whitespace they leave behind, so "My Mix / Test: 2024?" lands as
# "My Mix Test 2024".
echo "$HDRS" | grep -qi 'filename="My Mix Test 2024.zip"' \
  && pass "playlist name sanitised for the filename" || fail "bad sanitised name" "$(echo "$HDRS" | grep -i disposition)"

python3 - <<'PY'
import zipfile, sys
try:
    z = zipfile.ZipFile('/tmp/mf-itest.zip')
except Exception as e:
    print('  FAIL  archive could not be opened —', e); sys.exit(1)
bad = z.testzip()
print('  PASS  archive passes CRC check' if bad is None else f'  FAIL  corrupt entry: {bad}')
names = z.namelist()
want = ['First Song.mp3', 'Second Song.mp3', 'गाना तीन.mp3']
ok = sorted(names) == sorted(want)
print(f'  {"PASS" if ok else "FAIL"}  archive holds exactly the 3 good tracks — {names}')
a = z.read('First Song.mp3')
ok2 = a.startswith(b'FAKEMP3:AAAAAAAAAA1:') and len(a) == 20 + 20000
print(f'  {"PASS" if ok2 else "FAIL"}  payload bytes intact and mapped to the right title ({len(a)} bytes)')
ok3 = all(i.compress_type == 0 and (i.flag_bits & 0x800) for i in z.infolist())
print(f'  {"PASS" if ok3 else "FAIL"}  stored mode + UTF-8 flag on every entry')
PY

echo
echo "Cleanup & lifecycle"

ls "$RUN/temp_downloads" 2>/dev/null | grep -q "^${JOB}$" \
  && fail "work directory left behind after zipping" \
  || pass "per-job work directory removed after zipping"

ls "$RUN/temp_downloads" 2>/dev/null | grep -q "^${JOB}.zip$" \
  && pass "archive retained for retry after download" \
  || fail "archive missing from temp_downloads"

# Delivery is detected from the response stream settling, which lands some time
# after curl exits — how long depends on machine load, so poll for it rather than
# sleeping a fixed amount. (Asserting on the pre-flip state would be inherently
# racy in the other direction, so we don't.)
for i in $(seq 1 50); do
  S2b=$(api "/api/playlist-download/$JOB")
  echo "$S2b" | grep -q '"status":"downloaded"' && break
  sleep 0.2
done
echo "$S2b" | grep -q '"status":"downloaded"' \
  && pass "status flips to downloaded after delivery" || fail "expected downloaded" "$S2b"

# Re-download must still work after the status flip (interrupted save retry).
c=$(code GET "/api/playlist-download/$JOB/file")
check "$([ "$c" = 200 ] && echo 1)" "archive can be fetched again once downloaded -> 200" "got $c"

# Once a job is finished a new one is allowed.
START2=$(post /api/playlist-download '{"name":"Second Mix","tracks":[{"id":"EEEEEEEEEE5","title":"Solo"}]}')
JOB2=$(echo "$START2" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
check "$([ -n "$JOB2" ] && echo 1)" "a new job starts once the previous finished" "$START2"

# Cancel mid-flight.
CANCEL=$(post "/api/playlist-download/$JOB2/cancel" '{}')
sleep 2
S3=$(api "/api/playlist-download/$JOB2")
echo "$S3" | grep -qE '"status":"(cancelled|ready|downloaded)"' \
  && pass "cancel is accepted and settles the job" || fail "cancel left a bad state" "$S3"

echo
echo "All-tracks-fail path"
START3=$(post /api/playlist-download '{"name":"Doomed","tracks":[{"id":"FAILFAILFA1","title":"Broken"}]}')
JOB3=$(echo "$START3" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
for i in $(seq 1 40); do
  S4=$(api "/api/playlist-download/$JOB3")
  echo "$S4" | grep -qE '"status":"(ready|error|cancelled)"' && break
  sleep 0.5
done
echo "$S4" | grep -q '"status":"error"' \
  && pass "job with zero usable tracks reports error" || fail "expected error status" "$S4"
echo "$S4" | grep -q 'None of the tracks' \
  && pass "error message is specific" || fail "vague error" "$S4"
ls "$RUN/temp_downloads" 2>/dev/null | grep -q "^${JOB3}$" \
  && fail "failed job leaked its work directory" \
  || pass "failed job cleaned up its work directory"

echo
echo "Interrupted download"
# An aborted save must NOT be recorded as delivered, or the UI would tell the
# user their file arrived when it didn't.
#
# Two things have to be true for an interruption to be observable at all: the
# archive must be larger than the kernel will buffer (a few MB of socket buffer
# either side), and the client must still be mid-transfer when it hangs up. If
# the server manages to push the whole file into the buffers first, it has done
# everything it can observe, and no amount of code can tell the difference. Hence
# a deliberately large archive read slowly and then cut off early.
START5=$(post /api/playlist-download '{"name":"Big Mix","tracks":[{"id":"GGGGGGGGGG7","title":"Huge"}]}')
JOB5=$(echo "$START5" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
for i in $(seq 1 60); do
  S5=$(api "/api/playlist-download/$JOB5")
  echo "$S5" | grep -qE '"status":"(ready|error|cancelled)"' && break
  sleep 0.5
done
ZSIZE=$(stat -c %s "$RUN/temp_downloads/$JOB5.zip" 2>/dev/null || echo 0)
check "$([ "$ZSIZE" -gt 20000000 ] && echo 1)" "large archive built for the interruption test" "$ZSIZE bytes"

curl -s --limit-rate 100k --max-time 0.5 -o /tmp/mf-itest-partial.zip \
  "localhost:$PORT/api/playlist-download/$JOB5/file" >/dev/null 2>&1
PART=$(stat -c %s /tmp/mf-itest-partial.zip 2>/dev/null || echo 0)
check "$([ "$PART" -lt "$ZSIZE" ] && echo 1)" \
  "transfer really was cut short (precondition)" "got $PART of $ZSIZE bytes"

sleep 0.5
S5b=$(api "/api/playlist-download/$JOB5")
echo "$S5b" | grep -q '"status":"ready"' \
  && pass "interrupted transfer is not marked downloaded" || fail "abort was recorded as delivered" "$S5b"

# The archive must survive the interruption so the user can just click again.
ls "$RUN/temp_downloads" 2>/dev/null | grep -q "^${JOB5}.zip$" \
  && pass "archive kept after an interrupted transfer" \
  || fail "archive deleted after interrupted transfer"

c=$(code GET "/api/playlist-download/$JOB5/file")
check "$([ "$c" = 200 ] && echo 1)" "interrupted download can be retried -> 200" "got $c"
for i in $(seq 1 50); do
  S5c=$(api "/api/playlist-download/$JOB5")
  echo "$S5c" | grep -q '"status":"downloaded"' && break
  sleep 0.2
done
echo "$S5c" | grep -q '"status":"downloaded"' \
  && pass "completed retry flips to downloaded" || fail "retry not recorded" "$S5c"

echo
echo "Server log check"
grep -iE 'uncaught|unhandled' /tmp/mf-itest.log \
  && fail "server logged an uncaught error" \
  || pass "no uncaught exceptions or unhandled rejections"
echo
if [ "$FAILURES" = 0 ]; then echo "ALL PASSED"; else echo "$FAILURES FAILURE(S)"; fi
kill $SRV 2>/dev/null
exit $((FAILURES > 0))
