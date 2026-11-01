#!/bin/sh
# Builds the demo map, and copies the app's fonts and art, into site/, then deploys the landing page as the svall-site
# Worker. Only the files named here are sent, so the Caddyfile, compose file and tunnel token beside them stay out.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pnpm site:build
rm -rf dist/site && mkdir -p dist/site
(cd site && cp -R index.html og.jpg icon.svg icon-180.png lighthouse.svg fonts robots map shots _headers _redirects ../dist/site/)
pnpm exec wrangler deploy --config site/wrangler.jsonc
