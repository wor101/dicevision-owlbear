#!/usr/bin/env bash
# Build the extension and copy dist/ to the web root behind
# https://rodeo.dirtyowlbear.com (nginx/rodeo.conf in the dice-vision repo).
#
#   DEPLOY_TARGET=root@rodeo.dirtyowlbear.com:/var/www/rodeo scripts/deploy.sh
#   scripts/deploy.sh --no-build        # rsync an existing dist/ (CI builds first)
#
# DEPLOY_TARGET is an rsync destination (user@host:path); the default is the
# droplet's web root. DEPLOY_SSH_OPTS is passed to ssh (e.g. "-i ~/.ssh/deploy").
# nginx needs no reload: it serves whatever is in the directory. --delete keeps
# old hashed assets from piling up, --checksum keeps unchanged files' mtimes so
# their ETags survive a redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."

target="${DEPLOY_TARGET:-root@rodeo.dirtyowlbear.com:/var/www/rodeo}"
host="${target#*@}"
host="${host%%:*}"

if [[ "${1:-}" != "--no-build" ]]; then
  npm run build
fi

for f in manifest.json action.html background.html icon.svg icon.png store.md; do
  [[ -f "dist/$f" ]] || { echo "dist/$f missing; run npm run build" >&2; exit 1; }
done

version=$(node -p 'require("./dist/manifest.json").version')
echo "Deploying DiceVision for Owlbear Rodeo $version to $target"
rsync -az --delete --checksum --chmod=D755,F644 \
  -e "ssh ${DEPLOY_SSH_OPTS:-}" \
  dist/ "$target/"

# Confirm the live manifest is the one just copied. Not fatal: before DNS and
# the certificate exist (docs/backend/DEPLOYMENT.md in dice-vision) this fails
# although the files are in place.
if live=$(curl -fsS --max-time 15 "https://$host/manifest.json" 2>/dev/null); then
  live_version=$(node -p 'JSON.parse(process.argv[1]).version' "$live")
  if [[ "$live_version" == "$version" ]]; then
    echo "Live: https://$host/manifest.json is $live_version"
  else
    echo "WARNING: https://$host/manifest.json reports $live_version, expected $version" >&2
    exit 1
  fi
else
  echo "Copied, but https://$host/manifest.json is not reachable yet (DNS/cert?)" >&2
fi
