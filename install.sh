#!/usr/bin/env bash
# TeamPilot installer — no sudo needed.
#
#   From an unpacked release:   ./install.sh
#   From a release URL:         curl -fsSL <url>/install.sh | TEAMPILOT_TARBALL=<url>/teampilot-<v>.tgz bash
#
# Installs the app to ~/.teampilot/app (override: TEAMPILOT_APP_DIR) and a
# `teampilot` command to ~/.local/bin (override: TEAMPILOT_BIN_DIR). Workspaces
# live in ~/.teampilot/workspaces (override: TEAMPILOT_HOME) and are never
# touched by an upgrade — re-run the installer to upgrade.
set -euo pipefail

APP_DIR="${TEAMPILOT_APP_DIR:-$HOME/.teampilot/app}"
BIN_DIR="${TEAMPILOT_BIN_DIR:-$HOME/.local/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required: https://nodejs.org (or: brew install node / apt install nodejs)"
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=20?0:1)' \
  || fail "Node.js $(node --version) is too old; 20 or newer is required"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if [ -n "${TEAMPILOT_TARBALL:-}" ]; then
  if [ -f "$TEAMPILOT_TARBALL" ]; then
    cp "$TEAMPILOT_TARBALL" "$STAGE/tp.tgz"
  else
    say "Downloading $TEAMPILOT_TARBALL"
    curl -fsSL "$TEAMPILOT_TARBALL" -o "$STAGE/tp.tgz"
  fi
  tar -xzf "$STAGE/tp.tgz" -C "$STAGE"
  SRC="$STAGE/package"
elif [ -n "$HERE" ] && [ -f "$HERE/package.json" ] && grep -q '"name": "teampilot"' "$HERE/package.json"; then
  SRC="$HERE"
else
  fail "run this from an unpacked TeamPilot release, or set TEAMPILOT_TARBALL to a release URL"
fi

say "Installing to $APP_DIR"
mkdir -p "$APP_DIR.new"
( cd "$SRC" && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - . ) | ( cd "$APP_DIR.new" && tar -xf - )
( cd "$APP_DIR.new" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
chmod +x "$APP_DIR/bin/teampilot.js"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/teampilot" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/bin/teampilot.js" "\$@"
EOF
chmod +x "$BIN_DIR/teampilot"

say "Installed TeamPilot $(node "$APP_DIR/bin/teampilot.js" version)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH, e.g.:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
esac
cat <<'EOF'

Try it:      teampilot demo          (sample cards, no accounts needed)
Set up:      teampilot init          (one workspace per company or project)
Then:        teampilot doctor <workspace> --online
EOF
