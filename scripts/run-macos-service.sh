#!/bin/zsh
cd "/Users/office/Library/Application Support/OKXBoostAgent" || exit 1
export PATH="/Users/office/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export HOME="/Users/office"
exec /Users/office/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env src/server.js
