#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
    echo "usage: $0 <image>" >&2
    exit 2
fi

engine="${CONTAINER_ENGINE:-}"
if [[ -z "$engine" ]]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        engine=docker
    elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
        engine=podman
    else
        echo "error: no working docker or podman engine found" >&2
        exit 2
    fi
fi

topic="0123456789abcdef0123456789abcdef"
port="$(python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
)"

workdir="$(mktemp -d)"
container=""
cleanup() {
    if [[ -n "$container" ]]; then
        "$engine" logs "$container" >"$workdir/container.log" 2>&1 || true
        "$engine" rm -f "$container" >/dev/null 2>&1 || true
    fi
    rm -rf "$workdir"
}
trap cleanup EXIT

echo "starting $image with $engine on 127.0.0.1:$port"
analytics='<script defer data-domain="pixelntfy.smoke" src="https://plausible.smoke/js/script.js"></script>'

container="$("$engine" run -d --rm \
    -e NTFY_TOPIC="$topic" \
    -e NTFY_SERVER_URL="http://127.0.0.1:9" \
    -e ANALYTICS_SCRIPT_ELEMENT="$analytics" \
    -e PORT=80 \
    -p "127.0.0.1:${port}:80" \
    "$image")"

base="http://127.0.0.1:${port}"
ready=false
for _ in $(seq 1 60); do
    if curl -fsS "$base/" -o "$workdir/index.html" 2>/dev/null; then
        ready=true
        break
    fi
    sleep 1
done
if [[ "$ready" != true ]]; then
    echo "error: image did not become ready" >&2
    "$engine" logs "$container" >&2 || true
    exit 1
fi

grep -q '<title>PixelNtfy</title>' "$workdir/index.html"
grep -q 'id="createPixelForm"' "$workdir/index.html"
grep -q 'data-domain="pixelntfy.smoke"' "$workdir/index.html"
if grep -q 'ANALYTICS_SCRIPT_PLACEHOLDER' "$workdir/index.html"; then
    echo "error: analytics placeholder was not replaced" >&2
    exit 1
fi

status="$(curl -sS -o "$workdir/unauthorized.txt" -w '%{http_code}' \
    -X POST -H 'content-type: application/json' -H 'referer: http://pixelntfy.smoke/' \
    --data "{\"tag\":\"smoke\",\"ntfyTopic\":\"wrong-topic\"}" \
    "$base/tracking")"
if [[ "$status" != "403" ]]; then
    echo "error: wrong-topic request returned $status, expected 403" >&2
    exit 1
fi

curl -fsS -X POST -H 'content-type: application/json' -H 'referer: http://pixelntfy.smoke/' \
    --data "{\"tag\":\"smoke\",\"ntfyTopic\":\"$topic\"}" \
    "$base/tracking" > "$workdir/generated.json"

pixel_path="$(python3 - "$workdir/generated.json" <<'PY'
import json
import sys
import urllib.parse

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
url = payload.get("pixelUrl", "")
path = urllib.parse.urlparse(url).path
if not path.startswith("/tracking/"):
    raise SystemExit(f"unexpected pixelUrl: {url!r}")
print(path)
PY
)"

status="$(curl -sS -D "$workdir/pixel-headers.txt" -o "$workdir/pixel.gif" -w '%{http_code}' "$base$pixel_path")"
if [[ "$status" != "200" ]]; then
    echo "error: pixel request returned $status, expected 200" >&2
    exit 1
fi
grep -qi '^content-type: image/gif' "$workdir/pixel-headers.txt"
grep -qi '^cache-control: no-cache, no-store, must-revalidate' "$workdir/pixel-headers.txt"
if [[ ! -s "$workdir/pixel.gif" ]]; then
    echo "error: pixel response body is empty" >&2
    exit 1
fi

"$engine" run --rm "$image" npm ls --omit=dev --depth=0 > "$workdir/npm-ls.txt"
grep -q 'express@' "$workdir/npm-ls.txt"
grep -q 'axios@' "$workdir/npm-ls.txt"
grep -q 'dotenv@' "$workdir/npm-ls.txt"

echo "smoke test passed: static page, auth check, pixel generation, pixel access, production dependencies"
