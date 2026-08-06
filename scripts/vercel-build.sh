#!/usr/bin/env bash
#
# Build Konecta Pulse for Vercel, producing a Build Output API v3 directory.
#
# Why this rather than plain outputDirectory + functions config: those paths are
# resolved relative to the project's Root Directory setting. If that setting
# points anywhere other than the repository root, web/ and api/ are invisible
# and nothing can be found. Emitting .vercel/output into whichever directory
# Vercel is using sidesteps the setting entirely — the build locates the
# repository itself and stages a complete deployment wherever it is asked to.
#
# Argument $1 is the directory Vercel started in (its Root Directory). The
# caller has already moved us to the repository root.
set -euo pipefail

REPO="$PWD"
OUT_BASE="${1:-$PWD}"
OUT="$OUT_BASE/.vercel/output"

echo "Konecta Pulse build"
echo "  repository root : $REPO"
echo "  output base     : $OUT_BASE"
[ "$REPO" != "$OUT_BASE" ] && echo "  note: Vercel's Root Directory is not the repository root; staging output there anyway."

# ---------------------------------------------------------------- front end
echo "==> Building the front end"
( cd "$REPO/web" && npm run build )

# ------------------------------------------------------------- api function
echo "==> Bundling the API function"
FUNC="$OUT/functions/api.func"
rm -rf "$OUT"
mkdir -p "$FUNC" "$OUT/static"

# better-sqlite3 is a native addon and must not be bundled; it is copied in
# below so its compiled binary travels with the function.
npx --yes esbuild "$REPO/api/index.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:better-sqlite3 \
  --outfile="$FUNC/index.js" \
  --log-level=warning

# The addon plus the two packages it uses to locate itself at runtime.
mkdir -p "$FUNC/node_modules"
for pkg in better-sqlite3 bindings file-uri-to-path; do
  if [ -d "$REPO/node_modules/$pkg" ]; then
    cp -R "$REPO/node_modules/$pkg" "$FUNC/node_modules/"
  fi
done
# Prebuilt sources are large and never loaded at runtime.
rm -rf "$FUNC/node_modules/better-sqlite3/deps" "$FUNC/node_modules/better-sqlite3/src"

cat > "$FUNC/.vc-config.json" <<'JSON'
{
  "runtime": "nodejs22.x",
  "handler": "index.js",
  "launcherType": "Nodejs",
  "shouldAddHelpers": false,
  "memory": 1024,
  "maxDuration": 30
}
JSON

# ------------------------------------------------------------------- static
echo "==> Staging static files"
cp -R "$REPO/web/dist/." "$OUT/static/"

# Anything under /api goes to the function; real files win next; everything
# else falls back to the single page app.
cat > "$OUT/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "^/api(?:/.*)?$", "dest": "/api" },
    { "handle": "filesystem" },
    { "src": "/.*", "dest": "/index.html" }
  ]
}
JSON

echo "==> Done"
echo "  static files : $(find "$OUT/static" -type f | wc -l)"
echo "  function     : $(du -sh "$FUNC" | cut -f1)"
