#!/usr/bin/env bash
# Symlink pi collections into ~/.pi/agent/ so pi auto-discovers them.
#
# Usage:
#   ./install.sh            # install all collections
#   ./install.sh extensions # install one collection
#   ./install.sh --uninstall
#   ./install.sh --reinstall

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
COLLECTIONS=(extensions themes)

uninstall() {
  for name in "${COLLECTIONS[@]}"; do
    local link="$AGENT_DIR/$name"
    if [ -L "$link" ]; then
      rm "$link"
      echo "removed  $link"
    fi
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

if [ "${1:-}" = "--reinstall" ]; then
  uninstall
fi

mkdir -p "$AGENT_DIR"

targets=("${COLLECTIONS[@]}")
if [ -n "${1:-}" ] && [[ "${1:-}" != --* ]]; then
  targets=("$1")
fi

installed=0
for name in "${targets[@]}"; do
  src="$REPO_DIR/$name"
  link="$AGENT_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "skip    $name (no $src)"
    continue
  fi

  if [ -L "$link" ] && [ "$(readlink "$link")" = "$src" ]; then
    echo "ok      $link -> $src"
    continue
  fi

  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "WARN    $link exists and is not managed by this script — leaving it alone"
    continue
  fi

  ln -s "$src" "$link"
  echo "linked  $link -> $src"
  installed=1
done

if [ "$installed" = 1 ]; then
  echo
  echo "Done. Restart pi or run /reload to pick up changes."
fi
