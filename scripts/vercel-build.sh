#!/usr/bin/env bash
# Build the front end for Vercel.
#
# Vercel caps buildCommand at 256 characters, so this lives in a script rather
# than inline in vercel.json.
set -euo pipefail

if [ ! -d web ]; then
  echo ""
  echo "=============================================================="
  echo " Konecta Pulse cannot build from this directory."
  echo "=============================================================="
  echo ""
  echo " Working directory : $(pwd)"
  echo " Contains          : $(ls -A | tr '\n' ' ')"
  echo ""
  echo " Expected to find web/ and api/ here. Both live at the top"
  echo " level of the repository, so Vercel's Root Directory is"
  echo " pointing at a subdirectory and neither is reachable."
  echo ""
  echo " Fix, in the Vercel dashboard:"
  echo "   Settings -> Build and Deployment -> Root Directory"
  echo "   Clear the field so it is the repository root, then redeploy."
  echo ""
  echo " Note the Node version is read from the package.json in that"
  echo " same directory, so this also explains an unpinned Node."
  echo ""
  echo "=============================================================="
  echo ""
  exit 1
fi

echo "Building the front end from $(pwd)"
cd web
npm run build
