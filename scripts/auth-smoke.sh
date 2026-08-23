#!/usr/bin/env sh
# End-to-end smoke test for the Phase 1 auth endpoints, against a RUNNING
# server. This covers what no typecheck can: that the DDL actually applies, that
# every query runs, and that the endpoints behave over real HTTP.
#
# Usage:
#   scripts/auth-smoke.sh http://localhost:8013            # ordinary run
#   scripts/auth-smoke.sh http://localhost:8013 --rate-limit
#
# The base URL is REQUIRED and has no default, deliberately: on the production
# VPS the game is served from localhost:8003, and a default would eventually
# point this at it by accident.
#
# The user it creates is randomly named and deleted at the end, so a completed
# run leaves nothing behind. A run that fails partway may leave the user in
# place - the name is printed, so it can be cleaned up by hand.
#
# --rate-limit is opt-in because it spends most of the per-IP login budget
# (30 attempts / 15 min). Two runs with it inside one window will trip the
# limiter, and the second run's failures will be that, not a bug.
set -eu

BASE=${1:-}
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url> [--rate-limit]" >&2
  echo "  e.g. $0 http://localhost:8013" >&2
  exit 2
fi
RATE_LIMIT_TEST=${2:-}

command -v jq >/dev/null || { echo "this script needs jq" >&2; exit 2; }

USER="smoke$(od -An -N3 -tu4 /dev/urandom | tr -d ' ')"
PASS="smoke-password-1"
NEWPASS="smoke-password-2"
EMAIL="$USER@example.invalid"

failures=0
STATUS=""
BODY=""

# req METHOD PATH [JSON-BODY] [BEARER-TOKEN]
req() {
  _method=$1
  _path=$2
  _data=${3:-}
  _token=${4:-}
  set -- -sS -o /tmp/auth-smoke-body -w '%{http_code}' -X "$_method" "$BASE$_path"
  [ -n "$_data" ] && set -- "$@" -H 'Content-Type: application/json' -d "$_data"
  [ -n "$_token" ] && set -- "$@" -H "Authorization: Bearer $_token"
  STATUS=$(curl "$@")
  BODY=$(cat /tmp/auth-smoke-body)
}

expect() {
  _name=$1
  _want=$2
  _got=$3
  if [ "$_want" = "$_got" ]; then
    echo "ok: $_name"
  else
    echo "FAIL: $_name - expected $_want, got $_got"
    [ -n "$BODY" ] && echo "      body: $BODY"
    failures=$((failures + 1))
  fi
}

echo "Testing $BASE as user '$USER'"
echo

# --- registration -----------------------------------------------------------

req POST /api/auth/register "{\"username\":\"$USER\",\"password\":\"$PASS\"}"
expect "register a new user" 200 "$STATUS"
TOKEN=$(printf '%s' "$BODY" | jq -r '.token // empty')
expect "register returns a token" "yes" "$([ -n "$TOKEN" ] && echo yes || echo no)"
expect "register does not leak a password hash" "null" "$(printf '%s' "$BODY" | jq -r '.user.password_hash // .user.passwordHash // "null"')"

# The whole point of the generated username_lower column: scores are keyed
# case-sensitively, so "Erick" must reserve "erick" too.
req POST /api/auth/register "{\"username\":\"$(printf '%s' "$USER" | tr 'a-z' 'A-Z')\",\"password\":\"$PASS\"}"
expect "same username in different case is rejected" 409 "$STATUS"

req POST /api/auth/register '{"username":"ab","password":"long-enough-password"}'
expect "too-short username rejected" 400 "$STATUS"
req POST /api/auth/register '{"username":"has spaces","password":"long-enough-password"}'
expect "username with spaces rejected" 400 "$STATUS"
req POST /api/auth/register "{\"username\":\"${USER}x\",\"password\":\"short\"}"
expect "too-short password rejected" 400 "$STATUS"
req POST /api/auth/register "{\"username\":\"${USER}y\",\"password\":\"long-enough-password\",\"notifyDaily\":true}"
expect "subscribing without an email rejected" 400 "$STATUS"

# --- login ------------------------------------------------------------------

req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"$PASS\"}"
expect "login with correct password" 200 "$STATUS"
req POST /api/auth/login "{\"username\":\"$(printf '%s' "$USER" | tr 'a-z' 'A-Z')\",\"password\":\"$PASS\"}"
expect "login is case-insensitive on the username" 200 "$STATUS"
req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"wrong-password\"}"
expect "login with wrong password" 401 "$STATUS"
expect "wrong password gives a generic message" "username or password is incorrect" "$(printf '%s' "$BODY" | jq -r '.error')"
req POST /api/auth/login '{"username":"nobody-by-this-name","password":"wrong-password"}'
expect "unknown user gives the same message" "username or password is incorrect" "$(printf '%s' "$BODY" | jq -r '.error')"

# --- session handling -------------------------------------------------------

req GET /api/auth/me "" "$TOKEN"
expect "GET /me with a valid token" 200 "$STATUS"
expect "GET /me returns the right user" "$USER" "$(printf '%s' "$BODY" | jq -r '.user.username')"
req GET /api/auth/me
expect "GET /me without a token" 401 "$STATUS"
req GET /api/auth/me "" "not-a-real-token"
expect "GET /me with a garbage token" 401 "$STATUS"

# --- PATCH is a partial update ----------------------------------------------

req PATCH /api/auth/me "{\"email\":\"$EMAIL\",\"notifyDaily\":true}" "$TOKEN"
expect "set email and a subscription" 200 "$STATUS"
expect "email stored" "$EMAIL" "$(printf '%s' "$BODY" | jq -r '.user.email')"
expect "notifyDaily stored" "true" "$(printf '%s' "$BODY" | jq -r '.user.notifyDaily')"

# The regression that matters: a password-only change must not wipe the email
# or the flags it never mentioned.
req PATCH /api/auth/me "{\"currentPassword\":\"$PASS\",\"newPassword\":\"$NEWPASS\"}" "$TOKEN"
expect "change password" 200 "$STATUS"
expect "password change preserves email" "$EMAIL" "$(printf '%s' "$BODY" | jq -r '.user.email')"
expect "password change preserves notifyDaily" "true" "$(printf '%s' "$BODY" | jq -r '.user.notifyDaily')"
NEWTOKEN=$(printf '%s' "$BODY" | jq -r '.token // empty')
expect "password change issues a fresh token" "yes" "$([ -n "$NEWTOKEN" ] && echo yes || echo no)"

# Changing a password must evict every existing session.
req GET /api/auth/me "" "$TOKEN"
expect "old token is dead after a password change" 401 "$STATUS"
req GET /api/auth/me "" "$NEWTOKEN"
expect "new token works" 200 "$STATUS"
req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"$NEWPASS\"}"
expect "login with the new password" 200 "$STATUS"
TOKEN=$(printf '%s' "$BODY" | jq -r '.token')
req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"$PASS\"}"
expect "old password no longer works" 401 "$STATUS"

# Clearing an address must also clear the subscriptions that depend on it.
req PATCH /api/auth/me '{"email":"","notifyDaily":false}' "$TOKEN"
expect "clear the email" 200 "$STATUS"
expect "email cleared" "null" "$(printf '%s' "$BODY" | jq -r '.user.email // "null"')"

# --- logout -----------------------------------------------------------------

req POST /api/auth/logout "" "$TOKEN"
expect "logout" 204 "$STATUS"
req GET /api/auth/me "" "$TOKEN"
expect "token is dead after logout" 401 "$STATUS"
req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"$NEWPASS\"}"
expect "can log back in" 200 "$STATUS"
TOKEN=$(printf '%s' "$BODY" | jq -r '.token')

# --- rate limiting (opt-in) -------------------------------------------------

if [ "$RATE_LIMIT_TEST" = "--rate-limit" ]; then
  echo
  echo "Spending the login budget to check the limiter..."
  i=0
  saw429=no
  while [ $i -lt 14 ]; do
    req POST /api/auth/login '{"username":"rate-limit-probe","password":"wrong-password"}'
    [ "$STATUS" = "429" ] && { saw429=yes; break; }
    i=$((i + 1))
  done
  expect "repeated failed logins are eventually throttled" "yes" "$saw429"
  if [ "$saw429" = "yes" ]; then
    RETRY=$(curl -sS -o /dev/null -D - -X POST "$BASE/api/auth/login" \
      -H 'Content-Type: application/json' -d '{"username":"rate-limit-probe","password":"x"}' \
      | tr -d '\r' | awk 'tolower($1) == "retry-after:" { print $2 }')
    expect "429 carries a Retry-After header" "yes" "$([ -n "$RETRY" ] && echo yes || echo no)"
  fi
fi

# --- protected nicknames (Phase 2) ------------------------------------------

# The decision table: an unregistered name is free for anyone, a registered one
# needs that account's token, and someone else's token is no better than none.
echo
SEED=$(date -u +%Y-%m-%d)
score_body() {
  printf '{"nickname":"%s","difficulty":"hard","time":42.5,"stability":0.9,"inputLog":[1,2,3],"isCurrentPeriod":false}' "$1"
}

req POST "/api/scores/$SEED" "$(score_body "anon-$USER")"
expect "unregistered name submits anonymously" 200 "$STATUS"

req POST "/api/scores/$SEED" "$(score_body "$USER")"
expect "registered name refused without a token" 403 "$STATUS"

req POST "/api/scores/$SEED" "$(score_body "$USER")" "$TOKEN"
expect "registered name accepted with its own token" 200 "$STATUS"

req POST /api/auth/register "{\"username\":\"other$USER\",\"password\":\"$PASS\"}"
OTHERTOKEN=$(printf '%s' "$BODY" | jq -r '.token // empty')
if [ -n "$OTHERTOKEN" ]; then
  req POST "/api/scores/$SEED" "$(score_body "$USER")" "$OTHERTOKEN"
  expect "another account's token is refused" 403 "$STATUS"
  req DELETE /api/auth/me "{\"password\":\"$PASS\"}" "$OTHERTOKEN"
else
  echo "skip: another account's token - registration rate limit reached"
fi

# Run logs apply the same rule but fail open, so a forged one is dropped with a
# 200 rather than an error the game would have to handle.
req POST /api/runs "{\"nickname\":\"$USER\",\"seed\":\"$SEED\",\"status\":\"finished\",\"collected\":3}"
expect "forged run log is dropped, not rejected" 200 "$STATUS"
expect "and reports that it was dropped" "false" "$(printf '%s' "$BODY" | jq -r '.logged')"
req POST /api/runs "{\"nickname\":\"$USER\",\"seed\":\"$SEED\",\"status\":\"finished\",\"collected\":3}" "$TOKEN"
expect "own run log is kept" "true" "$(printf '%s' "$BODY" | jq -r '.logged')"

# Freezing a champion threshold is registered-only.
req POST "/api/champions/$SEED" '{"difficulty":"hard","championTime":30}'
expect "champion backfill refused without a token" 401 "$STATUS"

# --- account state (Phase 5) ------------------------------------------------

echo
req GET /api/me/state
expect "state needs a token" 401 "$STATUS"

req PUT /api/me/state "{\"state\":{\"completed\":[\"2026-08-20\"],\"played\":[\"2026-08-20\"],\"difficulty\":\"hard\",\"playTimeSeconds\":600,\"source\":\"reddit\"}}" "$TOKEN"
expect "push state" 200 "$STATUS"
expect "completed came back" "2026-08-20" "$(printf '%s' "$BODY" | jq -r '.state.completed[0]')"

# A second device pushing a different day must add to the first, not replace it.
req PUT /api/me/state "{\"state\":{\"completed\":[\"2026-08-21\"],\"difficulty\":\"easy\",\"playTimeSeconds\":60,\"source\":\"itch\"}}" "$TOKEN"
expect "days are unioned across devices" "2026-08-20 2026-08-21" "$(printf '%s' "$BODY" | jq -r '.state.completed | join(" ")')"
expect "the account's difficulty wins" "hard" "$(printf '%s' "$BODY" | jq -r '.state.difficulty')"
expect "play time keeps the larger" "600" "$(printf '%s' "$BODY" | jq -r '.state.playTimeSeconds')"
expect "acquisition source stays first-touch" "reddit" "$(printf '%s' "$BODY" | jq -r '.state.source')"

req GET /api/me/state "" "$TOKEN"
expect "state reads back" "2026-08-20 2026-08-21" "$(printf '%s' "$BODY" | jq -r '.state.completed | join(" ")')"

# Junk from a hostile client is dropped rather than stored.
req PUT /api/me/state '{"state":{"completed":["not-a-seed"],"playTimeSeconds":-1,"truck":{"primary":"red","secondary":"#000000","pattern":"polkadot"}}}' "$TOKEN"
expect "malformed seeds are not stored" "2026-08-20 2026-08-21" "$(printf '%s' "$BODY" | jq -r '.state.completed | join(" ")')"
expect "an invalid truck is rejected" "null" "$(printf '%s' "$BODY" | jq -r '.state.truck // "null"')"

req PUT /api/me/state '{"state":{"truck":{"primary":"#3a4653","secondary":"#2b3440","pattern":"diagonal"}}}' "$TOKEN"
expect "a valid truck is stored" "diagonal" "$(printf '%s' "$BODY" | jq -r '.state.truck.pattern')"

# The score submitted under this name earlier in the run should come back here.
req GET /api/me/bests "" "$TOKEN"
expect "bests are fetched in one request" 200 "$STATUS"
expect "the earlier score is among them" "true" "$(printf '%s' "$BODY" | jq -r --arg s "$SEED" '[.bests[] | select(.seed == $s)] | length > 0')"
expect "a best carries its input log" "true" "$(printf '%s' "$BODY" | jq -r '.bests[0].inputLog | type == "array"')"

# --- deletion ---------------------------------------------------------------

echo
req DELETE /api/auth/me '{"password":"definitely-not-it"}' "$TOKEN"
expect "delete with the wrong password" 403 "$STATUS"
req DELETE /api/auth/me "{\"password\":\"$NEWPASS\"}" "$TOKEN"
expect "delete the account" 204 "$STATUS"
req POST /api/auth/login "{\"username\":\"$USER\",\"password\":\"$NEWPASS\"}"
expect "deleted account can no longer log in" 401 "$STATUS"
req GET /api/auth/me "" "$TOKEN"
expect "session died with the account (ON DELETE CASCADE)" 401 "$STATUS"

rm -f /tmp/auth-smoke-body
echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all auth smoke checks passed"
