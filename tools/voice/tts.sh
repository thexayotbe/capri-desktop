#!/bin/bash
# Fetches Capri's raw voice takes from ElevenLabs (text-to-speech with timestamps) into
# tools/voice/raw/<key>/NN.mp3 + NN.align.json (character timings, used for the stutters).
# Only missing takes are fetched (delete one to re-take it), so re-running costs nothing.
# The API key is read from a file, only inside the curl call, never printed or stored:
#   tools/voice/tts.sh <key file> [key ...]        or   ELEVENLABS_KEY_FILE=<key file> tools/voice/tts.sh [key ...]
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ $# -gt 0 && -f "$1" ]]; then KEYFILE=$1; shift; else KEYFILE=${ELEVENLABS_KEY_FILE:-}; fi
[[ -n "$KEYFILE" && -f "$KEYFILE" ]] || { echo "usage: tools/voice/tts.sh <key file> [key ...] (or set ELEVENLABS_KEY_FILE)" >&2; exit 1; }
LINES=tools/voice/lines.json
RAW=tools/voice/raw
VOICE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["voice_id"])' "$LINES")
chars=0
while IFS=$'\t' read -r key nn body; do
  dir="$RAW/$key"; f="$dir/$nn"
  [[ -s "$f.mp3" ]] && continue
  mkdir -p "$dir"
  code=$(curl -s -o "$f.part" -w '%{http_code}' \
    "https://api.elevenlabs.io/v1/text-to-speech/$VOICE/with-timestamps?output_format=mp3_44100_128" \
    -H "xi-api-key: $(cat "$KEYFILE")" -H 'Content-Type: application/json' -d "$body")
  if [[ "$code" == 200 ]]; then
    python3 - "$f" <<'PY'
import json, sys, base64
f = sys.argv[1]; d = json.load(open(f + '.part'))
open(f + '.mp3', 'wb').write(base64.b64decode(d['audio_base64']))
json.dump({'alignment': d.get('alignment'), 'normalized_alignment': d.get('normalized_alignment')}, open(f + '.align.json', 'w'))
PY
    rm -f "$f.part"
    n=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])["text"]))' "$body"); chars=$((chars + n))
    echo "got $key/$nn ($n chars)"
  else
    echo "FAILED $key/$nn: HTTP $code $(head -c 300 "$f.part")" >&2; rm -f "$f.part"
    [[ "$code" == 401 || "$code" == 402 || "$code" == 429 ]] && break
  fi
done < <(python3 - "$LINES" "$@" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); want = sys.argv[2:]
for key, takes in d['keys'].items():
    if want and key not in want: continue
    for i, t in enumerate(takes):
        body = dict(text=t['text'], model_id=d['model_id'], voice_settings=dict(stability=t.get('stab', 0.5)))
        print('%s\t%02d\t%s' % (key, i + 1, json.dumps(body)))
PY
)
echo "fetched $chars characters this run"
