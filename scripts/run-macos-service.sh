#!/bin/zsh
cd "/Users/office/Library/Application Support/OKXBoostAgent" || exit 1
export PATH="/Users/office/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export HOME="/Users/office"
# Route onchainos CLI outbound calls through the local system proxy
# (browsers use it automatically; CLI processes do not).
export HTTPS_PROXY="http://127.0.0.1:1082"
export HTTP_PROXY="http://127.0.0.1:1082"
export https_proxy="http://127.0.0.1:1082"
export http_proxy="http://127.0.0.1:1082"
export ALL_PROXY="http://127.0.0.1:1082"
export NO_PROXY="localhost,127.0.0.1"
exec /Users/office/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env src/server.js
