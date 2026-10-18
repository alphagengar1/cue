#!/usr/bin/env bash
# Pre-demo check. Verifies that the secrets are set, the backend answers with the token, and the app env is wired.
# Never prints a secret value: only variable names and pass/fail.
#
#   backend/scripts/demo-check.sh            # backend at BASE_URL or http://127.0.0.1:8787
#   BASE_URL=http://172.20.10.2:8787 backend/scripts/demo-check.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$HERE/.." && pwd)"
REPO_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
BACKEND_ENV="$BACKEND_DIR/.env"
APP_ENV="$REPO_DIR/app/.env.local"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
BASE_URL="${BASE_URL%/}"

pass=0; fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# Value of KEY in an env file (first match, unquoted, trimmed). Printed only into variables, never to the terminal.
env_value() {
  local file="$1" key="$2" line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | head -n 1)" || true
  line="${line#*=}"
  line="${line%%#*}"
  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "$line"
}

check_env_file() {
  local file="$1"; shift
  local label="${file#"$REPO_DIR"/}"
  if [ ! -f "$file" ]; then
    bad "$label is missing"
    for k in "$@"; do bad "$label: $k (file missing)"; done
    return
  fi
  for k in "$@"; do
    local v; v="$(env_value "$file" "$k")"
    if [ -z "$v" ]; then
      bad "$label: $k is empty or missing"
    elif printf '%s' "$v" | grep -qiE '^(change-me|your-|xxx|\+1X)'; then
      bad "$label: $k still has the placeholder from .env.example"
    else
      ok "$label: $k set (${#v} chars)"
    fi
  done
}

echo "backend env"
check_env_file "$BACKEND_ENV" \
  ANTHROPIC_API_KEY DEEPGRAM_API_KEY EXA_API_KEY OPENAI_API_KEY \
  SPECTRUM_PROJECT_ID SPECTRUM_PROJECT_SECRET WEARER_PHONE DEVICE_TOKEN

echo "backend GET $BASE_URL/api/state"
TOKEN="$(env_value "$BACKEND_ENV" DEVICE_TOKEN)"
if ! command -v curl >/dev/null 2>&1; then
  bad "curl not found"
else
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/state" 2>/dev/null)" || code="000"
  case "$code" in
    200)
      ok "/api/state answers 200 with the token"
      body="$(curl -sS --max-time 5 -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/state" 2>/dev/null)" || body=""
      if printf '%s' "$body" | grep -q '"event":null'; then
        bad "/api/state: no active event loaded (load one on the setup page or set SAMPLE_EVENT_FILE)"
      elif printf '%s' "$body" | grep -q '"event":{'; then
        ok "/api/state: an event is active"
      fi
      ;;
    401|403) bad "/api/state answered $code: DEVICE_TOKEN in backend/.env does not match the running backend" ;;
    000)     bad "backend not reachable at $BASE_URL (is it running? set BASE_URL for the hotspot address)" ;;
    *)       bad "/api/state answered $code" ;;
  esac
  if [ -n "$TOKEN" ]; then
    anon="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/api/state" 2>/dev/null)" || anon="000"
    case "$anon" in
      401|403) ok "/api/state rejects a request without the token ($anon)" ;;
      200)     bad "/api/state answers 200 WITHOUT a token: the running backend has no DEVICE_TOKEN (restart it after editing .env)" ;;
      000)     ;; # already reported above
      *)       bad "/api/state without token answered $anon" ;;
    esac
  fi
fi

echo "app env"
check_env_file "$APP_ENV" VITE_BACKEND_URL VITE_DEVICE_TOKEN
if [ -f "$APP_ENV" ] && [ -f "$BACKEND_ENV" ]; then
  if [ -n "$TOKEN" ] && [ "$(env_value "$APP_ENV" VITE_DEVICE_TOKEN)" != "$TOKEN" ]; then
    bad "app/.env.local: VITE_DEVICE_TOKEN differs from backend DEVICE_TOKEN"
  elif [ -n "$TOKEN" ]; then
    ok "app/.env.local: VITE_DEVICE_TOKEN matches backend DEVICE_TOKEN"
  fi
  app_url="$(env_value "$APP_ENV" VITE_BACKEND_URL)"
  case "$app_url" in
    http://localhost*|http://127.0.0.1*) bad "app/.env.local: VITE_BACKEND_URL points at localhost; the glasses app on the phone cannot reach that" ;;
    http://*|https://*) ok "app/.env.local: VITE_BACKEND_URL is an http(s) URL" ;;
    "") ;; # already reported
    *) bad "app/.env.local: VITE_BACKEND_URL is not a URL" ;;
  esac
  mock="$(env_value "$APP_ENV" VITE_MOCK)"
  if [ -n "$mock" ] && [ "$mock" != "0" ] && [ "$mock" != "false" ]; then
    bad "app/.env.local: VITE_MOCK is on; the app will not call the backend"
  fi
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
