#!/usr/bin/env bash
# Builds the @coderline/alphatab and @coderline/alphatab-vite archives used by tabz.
# The main archive also ships MuseScore_General.sf3 (MIT) and its license in dist/soundfont/,
# the Vite plugin copies them with the other SoundFonts.
#
# Usage: tabz/pack.sh <dir with MuseScore_General.sf3 and MuseScore_General_License.md> <output dir>
# Run it from a real clone (not a git worktree) after `npm ci`.
# Download: https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/
set -euo pipefail

SOUNDFONT_SHA256=5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3

SOUNDFONT_DIR=$(cd "$1" && pwd)
mkdir -p "$2"
OUT=$(cd "$2" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "$SOUNDFONT_SHA256  $SOUNDFONT_DIR/MuseScore_General.sf3" | shasum -a 256 -c -
test -f "$SOUNDFONT_DIR/MuseScore_General_License.md"

npm run build
npm run build-vite
# the prepack script of packages/alphatab also copies the webpack plugin
npm run build-webpack

cp "$SOUNDFONT_DIR/MuseScore_General.sf3" "$SOUNDFONT_DIR/MuseScore_General_License.md" packages/alphatab/dist/soundfont/

# the prepack script switches "type" to commonjs in package.json, restore it in any case
trap 'git checkout -- packages/alphatab/package.json' EXIT
(cd packages/alphatab && npm pack --pack-destination "$OUT")
(cd packages/vite && npm pack --pack-destination "$OUT")

echo "Packed from $(git rev-parse HEAD) into $OUT"
