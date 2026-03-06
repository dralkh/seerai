#!/usr/bin/env bash
# Creates a release: bumps version, builds, commits, tags, pushes, and creates GitHub release with scaffold assets.
set -euo pipefail

ROOT_DIR=$(pwd)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: $0 [major|minor|patch|<version>]"
  exit 1
fi

KIND="$1"

echo "Bumping version ($KIND) ..."
NEW_VERSION=$(node "$SCRIPT_DIR/release.js" "$KIND")
echo "New version: $NEW_VERSION"

echo "Building project..."
npm run build

XPI=".scaffold/build/$(ls .scaffold/build | grep ".xpi$" | head -n1)"
if [ ! -f "$XPI" ]; then
  echo "XPI not found in .scaffold/build"
  exit 1
fi

git add package.json
git add .scaffold/build || true
git commit -m "chore(release): v$NEW_VERSION" || {
  echo "No changes to commit (maybe only build artifacts)."
}

echo "Tagging v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo "Pushing commits and tags"
git push
git push --tags

echo "Creating GitHub release (uses last commit) and uploading assets..."
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found; create release manually at GitHub"
  exit 0
fi

RELEASE_BODY="Release v$NEW_VERSION\n\nBuilt from $(git rev-parse --short HEAD)"

gh release create "v$NEW_VERSION" "$XPI" --title "v$NEW_VERSION" --notes "$RELEASE_BODY"

echo "Release created: v$NEW_VERSION"
