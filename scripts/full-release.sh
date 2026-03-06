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

echo "Building project (production)..."
# ensure build writes update.json/update-beta.json and packs the XPI
NODE_ENV=production npm run build

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

# Upload update.json/update-beta.json to the versioned release if present
if [ -f ".scaffold/build/update.json" ]; then
  echo "Uploading update.json to release v$NEW_VERSION"
  gh release upload "v$NEW_VERSION" ".scaffold/build/update.json" --clobber || true
fi

# Verify uploaded assets are reachable from GitHub releases (versioned and 'release')
origin_url=$(git remote get-url origin 2>/dev/null || true)
if [ -n "$origin_url" ]; then
  # Normalize to https://github.com/owner/repo
  if [[ "$origin_url" == git@github.com:* ]]; then
    repo_path=${origin_url#git@github.com:}
  else
    repo_path=${origin_url#https://github.com/}
    repo_path=${repo_path#git+https://github.com/}
  fi
  repo_path=${repo_path%.git}
  base_url="https://github.com/$repo_path/releases/download"

  for manifest in update.json update-beta.json; do
    for tag in "v$NEW_VERSION" release; do
      url="$base_url/$tag/$manifest"
      echo -n "Checking $url ... "
      if curl -sSfI "$url" >/dev/null 2>&1; then
        echo "OK"
      else
        echo "MISSING or unreachable"
      fi
    done
  done

  # check MCP files
  for m in "${MCP_FILES[@]:-}"; do
    filename=$(basename "$m")
    for tag in "v$NEW_VERSION" release; do
      url="$base_url/$tag/$filename"
      echo -n "Checking $url ... "
      if curl -sSfI "$url" >/dev/null 2>&1; then
        echo "OK"
      else
        echo "MISSING or unreachable"
      fi
    done
  done
fi
if [ -f ".scaffold/build/update-beta.json" ]; then
  echo "Uploading update-beta.json to release v$NEW_VERSION"
  gh release upload "v$NEW_VERSION" ".scaffold/build/update-beta.json" --clobber || true
fi

echo "Release created: v$NEW_VERSION"

# Ensure there is a special release with tag 'release' that hosts update.json files
if [ -f ".scaffold/build/update.json" ] || [ -f ".scaffold/build/update-beta.json" ]; then
  if gh release view "release" >/dev/null 2>&1; then
    echo "Uploading update manifests to release 'release' (will replace existing assets)"
    if [ -f ".scaffold/build/update.json" ]; then
      gh release upload "release" ".scaffold/build/update.json" --clobber || true
    fi
    if [ -f ".scaffold/build/update-beta.json" ]; then
      gh release upload "release" ".scaffold/build/update-beta.json" --clobber || true
    fi
  else
    echo "Creating release 'release' to host update manifests"
    # create a lightweight release named 'release' containing the manifests
    if [ -f ".scaffold/build/update.json" ]; then
      gh release create "release" ".scaffold/build/update.json" --title "update manifests" --notes "Hosting update.json and update-beta.json for Zotero auto-updater." || true
    else
      # create an empty release (draft) and then upload files
      gh release create "release" --title "update manifests" --notes "Hosting update.json and update-beta.json for Zotero auto-updater." || true
    fi
    if [ -f ".scaffold/build/update-beta.json" ]; then
      gh release upload "release" ".scaffold/build/update-beta.json" --clobber || true
    fi
  fi
fi

# Upload seerai-mcp bundle if present
MCP_GLOB=(.scaffold/build/seerai-mcp.*)
MCP_FILES=()
for f in "${MCP_GLOB[@]}"; do
  [ -e "$f" ] || continue
  MCP_FILES+=("$f")
done

if [ ${#MCP_FILES[@]} -gt 0 ]; then
  echo "Found MCP files: ${MCP_FILES[*]}"
  for m in "${MCP_FILES[@]}"; do
    echo "Uploading $m to release v$NEW_VERSION"
    gh release upload "v$NEW_VERSION" "$m" --clobber || true
  done

  # also upload to the host 'release' so updater can fetch it from the stable release
  if gh release view "release" >/dev/null 2>&1; then
    for m in "${MCP_FILES[@]}"; do
      echo "Uploading $m to release 'release'"
      gh release upload "release" "$m" --clobber || true
    done
  else
    echo "Release 'release' not found; creating it and uploading MCP files"
    # create a minimal release and upload the MCP file(s)
    gh release create "release" --title "update manifests" --notes "Hosting update manifests and MCP bundles for Zotero auto-updater." || true
    for m in "${MCP_FILES[@]}"; do
      gh release upload "release" "$m" --clobber || true
    done
  fi
fi
