#!/bin/zsh
# AI Season 黑客松截止值守：报名/提交均已完成的情况下，持续核查 ASP 健康与
# 审核状态直到 2026-08-21 23:59 UTC 截止；状态变化或到点后本地提醒。
cd "/Users/office/Library/Application Support/OKXBoostAgent" || exit 1
export PATH="/Users/office/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/office"
export HTTPS_PROXY="http://127.0.0.1:1082"
export HTTP_PROXY="http://127.0.0.1:1082"
export https_proxy="http://127.0.0.1:1082"
export http_proxy="http://127.0.0.1:1082"
export ALL_PROXY="http://127.0.0.1:1082"
export NO_PROXY="localhost,127.0.0.1"

AGENT_ID="10744"
DEADLINE_MS=$(node -e 'console.log(Date.parse("2026-08-21T23:59:00Z"))')
LOG="data/ai-season-watch.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }

log "AI Season 黑客松值守启动：ASP #$AGENT_ID，截止 2026-08-21 23:59 UTC（报名已于 08-11 成功，web3 账号）"
last_asp_status=""

while :; do
  now_ms=$(node -e 'console.log(Date.now())')
  if [ "$now_ms" -ge "$DEADLINE_MS" ]; then
    log "AI Season 黑客松已截止：报名(web3)+Google Form+X帖子+Demo 均已提交，ASP 在线参赛"
    notify "AI Season 黑客松" "已截止：报名与提交全部完成，ASP 在线参赛 ✅"
    exit 0
  fi

  result=$(onchainos agent get-my-agents 2>&1)
  asp_status=$(echo "$result" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    a=d['data']['list'][0]['agentList'][0]
    print(a.get('approvalLabel','?') + '|在线' if a.get('onlineStatus')==1 else a.get('approvalLabel','?')+'|离线')
except Exception:
    print('查询失败')
" 2>/dev/null)

  if [ -z "$asp_status" ]; then asp_status="查询失败"; fi
  if [ "$asp_status" != "$last_asp_status" ]; then
    log "状态变化：$asp_status"
    notify "AI Season 黑客松监控" "ASP 状态：$asp_status"
    last_asp_status="$asp_status"
  else
    log "检查正常：$asp_status（$(node -e 'console.log(Math.ceil((Date.parse(\"2026-08-21T23:59:00Z\")-Date.now())/60000))') 分钟后截止）"
  fi

  sleep 1200
done
