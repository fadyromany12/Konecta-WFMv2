#!/usr/bin/env bash
# Build the front end for Vercel.
#
# Vercel caps buildCommand at 256 characters, so the check lives here rather
# than inline in vercel.json.
set -euo pipefail

if [ ! -d web ]; then
  echo ""
  echo ">>> Konecta Pulse cannot build from here."
  echo ">>> Vercel's Root Directory points at a subdirectory, so web/ and api/ are not visible."
  echo ">>> Both live at the top level of the repository and neither can be reached from here."
  echo ""
  echo ">>> Fix: Project Settings -> Build and Deployment -> Root Directory."
  echo ">>>      Clear it so it points at the repository root, then redeploy."
  echo ""
  exit 1
fi

cd web
npm run build
