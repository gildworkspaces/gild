#!/bin/sh
# Bundles the container server with the CLI's import code
# (/Volumes/Projects/claude/gild-cli, sibling checkout).
set -e
cd "$(dirname "$0")"
bunx esbuild server.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/server.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
