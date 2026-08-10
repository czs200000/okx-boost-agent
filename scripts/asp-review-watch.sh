#!/bin/zsh
# Watch the OKX.AI Trading Hackathon ASP review and auto-register once approved.
# Runs until the registration deadline (2026-08-11 12:00 UTC+8), then exits.
cd "/Users/office/Library/Application Support/OKXBoostAgent" || exit 1
export PATH="/Users/office/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/office"
# Route onchainos CLI outbound calls through the local system proxy.
export HTTPS_PROXY="http://127.0.0.1:1082"
export HTTP_PROXY="http://127.0.0.1:1082"
export https_proxy="http://127.0.0.1:1082"
export http_proxy="http://127.0.0.1:1082"
export ALL_PROXY="http://127.0.0.1:1082"
export NO_PROXY="localhost,127.0.0.1"

AGENT_ID="10744"
DEADLINE_MS=$(node -e 'console.log(Date.parse("2026-08-11T04:00:00Z"))') # 8/11 12:00 UTC+8
LOG="data/asp-review-watch.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }

log "审核监控启动：ASP #$AGENT_ID（网格智投 · OKB GridBot），报名截止 2026-08-11 12:00 UTC+8"

while :; do
  now_ms=$(node -e 'console.log(Date.now())')
  if [ "$now_ms" -ge "$DEADLINE_MS" ]; then
    log "报名截止已过，本季无法报名，监控结束"
    notify "OKX.AI 黑客松" "报名截止：本季未赶上（ASP 仍在审核或未通过）"
    exit 0
  fi

  result=$(onchainos hackathon register --agent-id "$AGENT_ID" --account-type web3 2>&1)
  if echo "$result" | grep -q '"ok":true'; then
    log "✅ 黑客松报名成功：$result"
    notify "OKX.AI 黑客松" "报名成功！ASP 网格智投 · OKB GridBot 已参赛"
    exit 0
  elif echo "$result" | grep -qi 'under review'; then
    log "ASP 仍在审核中，5 分钟后重试"
  elif echo "$result" | grep -qi 'has not submitted for review'; then
    log "ASP 尚未提交审核，5 分钟后重试"
  else
    log "报名返回其他结果，停止监控：$result"
    notify "OKX.AI 黑客松" "报名监控异常：$result"
    exit 1
  fi

  sleep 300
done
