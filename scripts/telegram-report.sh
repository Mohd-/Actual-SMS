#!/bin/sh
# Daily SMS import review -> Telegram.
# Cron runs with a minimal environment, so secrets come from gitignored .gitenv
# and binaries are resolved by absolute path.
set -eu

REPO_DIR="${ACTUAL_SMS_REPO_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
WINDOW="${1:-last 24 hours}"

cd "$REPO_DIR"

if [ ! -f .env ]; then
  echo "telegram-report: .env with TG_TOKEN/TG_CHAT_ID not found" >&2
  exit 1
fi
# shellcheck disable=SC1091
. ./.env

if [ -z "${TG_TOKEN:-}" ] || [ -z "${TG_CHAT_ID:-}" ]; then
  echo "telegram-report: TG_TOKEN and TG_CHAT_ID must be set in .env" >&2
  exit 1
fi

MSG=$("$OPENCODE_BIN" run --agent log-reviewer "$WINDOW")

if [ -z "$MSG" ]; then
  echo "telegram-report: opencode produced no output" >&2
  exit 1
fi

# Telegram hard-caps messages at 4096 characters. The report is generated text
# and may contain arbitrary Markdown punctuation, so send it as plain text.
CUT=$(printf '%s' "$MSG" | head -c 4000)
curl -fsS "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
  -d chat_id="$TG_CHAT_ID" \
  --data-urlencode "text=$CUT"
