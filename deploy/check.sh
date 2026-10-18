#!/usr/bin/env bash
# Checks a deployed Cue backend over HTTPS and prints PASS/FAIL per check.
#
#   deploy/check.sh 54.1.2.3            # host becomes 54.1.2.3.sslip.io
#   deploy/check.sh 54.1.2.3.sslip.io
#   deploy/check.sh api.cue.example
#
# The device token comes from $DEVICE_TOKEN, else from backend/.env next to this repo.
# The token is never printed.
set -u

[[ $# -ge 1 ]] || { echo "usage: $0 <ip | host>" >&2; exit 2; }
HOST="$1"
[[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && HOST="$HOST.sslip.io"
HOST="${HOST#https://}"; HOST="${HOST%/}"
BASE="https://$HOST"

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/../backend/.env"
TOKEN="${DEVICE_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$ENV_FILE" ]]; then
  TOKEN="$(grep -E '^DEVICE_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '[:space:]')"
fi

fails=0
pass() { printf '\033[1;32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
skip() { printf '\033[1;33mSKIP\033[0m  %s\n' "$*"; }

echo "Checking $BASE"

# 1. TLS + reachability + auth gate: /api/state without a token must be 401.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/state" 2>/tmp/cue-check-err || true)"
case "$code" in
  401) pass "TLS valid, backend reachable, /api/* requires the device token (401 without it)" ;;
  200) fail "/api/state answered 200 WITHOUT a token: DEVICE_TOKEN is not set on the server" ;;
  000) fail "could not connect or TLS failed: $(tr -d '\n' </tmp/cue-check-err)" ;;
  502|503) fail "Caddy is up but the backend is not ($code). On the server: journalctl -u cue-backend -n 50" ;;
  *)   fail "unexpected status $code from /api/state without a token" ;;
esac

# 2. With the token: 200 and the state shape from 01 section 4.2.
if [[ -z "$TOKEN" ]]; then
  skip "no DEVICE_TOKEN in env or backend/.env, cannot test an authenticated call"
else
  body="$(curl -sS --max-time 15 -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' "$BASE/api/state" 2>/dev/null || true)"
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [[ "$code" == "200" && "$body" == *'"goal"'* && "$body" == *'"orgs"'* ]]; then
    ev="$(printf '%s' "$body" | sed -nE 's/.*"event":\{[^}]*"name":"([^"]*)".*/\1/p' | head -1)"
    pass "GET /api/state with token -> 200 (active event: ${ev:-none})"
  elif [[ "$code" == "401" ]]; then
    fail "token rejected (401): local DEVICE_TOKEN differs from the one in the server's backend/.env"
  else
    fail "GET /api/state with token -> $code"
  fi
fi

# 3. CORS preflight for the Even WebView (01 section 6).
hdrs="$(curl -sS --max-time 15 -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://example.invalid' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-audio-format' \
  "$BASE/api/briefs/text" 2>/dev/null || true)"
if printf '%s' "$hdrs" | grep -qi '^access-control-allow-origin: \*' && printf '%s' "$hdrs" | grep -qi '^access-control-allow-headers:.*authorization'; then
  pass "CORS preflight allows Authorization from any origin"
else
  fail "CORS preflight missing Access-Control-Allow-Origin: * or Authorization in Allow-Headers"
fi

# 4. Setup page for the laptop.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/setup" 2>/dev/null || true)"
[[ "$code" == "200" ]] && pass "GET /setup -> 200" || fail "GET /setup -> $code"

echo
if [[ $fails -eq 0 ]]; then
  echo "ALL PASS. Backend URL: $BASE"
  echo "Build the app with VITE_BACKEND_URL=$BASE and VITE_DEVICE_TOKEN=<same DEVICE_TOKEN>, and whitelist $BASE in app/app.json."
else
  echo "$fails check(s) FAILED for $BASE"
fi
exit $(( fails > 0 ))
