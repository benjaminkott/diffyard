#!/usr/bin/env bash
#
# Puts `diffyard` on the PATH.
#
# By symlinking rather than copying or installing globally: the tool is
# developed in this checkout, so a link means `diffyard` is always what is in the
# working tree, and removing it is removing a link. Nothing is written outside
# the bin directory, and no shell file is edited — where something has to be
# added to one, this prints the line and leaves the choice.

set -euo pipefail

readonly PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly COMMANDS=(diffyard diffyard-mcp)
readonly NODE_MINIMUM=24

BIN_DIR="${DIFFYARD_BIN_DIR:-$HOME/.local/bin}"
ACTION=install

# ---------------------------------------------------------------- appearance

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  readonly BOLD=$'\033[1m' GREY=$'\033[90m' RED=$'\033[31m' GREEN=$'\033[32m' OFF=$'\033[0m'
else
  readonly BOLD='' GREY='' RED='' GREEN='' OFF=''
fi

say()  { printf '  %s\n' "$*"; }
note() { printf '  %s%s%s\n' "$GREY" "$*" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
die()  { printf '\n  %s✗%s %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

usage() {
  cat <<USAGE

  ${BOLD}install.sh${OFF} — put diffyard on the PATH

    ./install.sh                 link into ~/.local/bin
    ./install.sh --prefix DIR    link into DIR instead
    ./install.sh --uninstall     remove the links again

  The directory can also come from DIFFYARD_BIN_DIR.

USAGE
}

# ------------------------------------------------------------------ argument

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -ge 2 ] || die "--prefix needs a directory"
      BIN_DIR="$2"
      shift 2
      ;;
    --prefix=*) BIN_DIR="${1#*=}"; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $1" ;;
  esac
done

printf '\n  %sdiffyard%s %s\n\n' "$BOLD" "$OFF" "${GREY}${PROJECT}${OFF}"

# ----------------------------------------------------------------- uninstall

if [ "$ACTION" = uninstall ]; then
  removed=0
  for command in "${COMMANDS[@]}"; do
    link="$BIN_DIR/$command"
    # Only ever remove a link that points into this checkout, so an install
    # from somewhere else — or a real file of that name — is left alone.
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$PROJECT/bin/$command.mjs" ]; then
      rm "$link"
      ok "removed $link"
      removed=$((removed + 1))
    fi
  done

  [ "$removed" -gt 0 ] || note "nothing of this checkout was linked in $BIN_DIR"
  printf '\n'
  exit 0
fi

# ------------------------------------------------------------- what it needs

command -v node >/dev/null 2>&1 || die "Node is not on the PATH. diffyard needs Node ${NODE_MINIMUM} or newer."

node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"

if [ "$node_major" -lt "$NODE_MINIMUM" ]; then
  die "Node ${node_version} is too old; diffyard needs ${NODE_MINIMUM} or newer."
fi
ok "node ${node_version}"

# The bundle is what gets linked, so it has to exist and be no older than the
# sources it was built from.
needs_build=false
if [ ! -f "$PROJECT/bin/diffyard.mjs" ]; then
  needs_build=true
else
  for source in "$PROJECT"/src/*.ts; do
    [ "$source" -nt "$PROJECT/bin/diffyard.mjs" ] && needs_build=true && break
  done
fi

if [ "$needs_build" = true ]; then
  # Fetching them is what the reader would do next anyway, and telling them to
  # go and do it is a step that exists only because this script would not.
  if [ ! -d "$PROJECT/node_modules" ]; then
    say "installing dependencies…"
    (cd "$PROJECT" && npm install --silent --ignore-scripts) \
      || die "npm install failed. Run it in $PROJECT to see why."
  fi

  say "building…"
  (cd "$PROJECT" && npm run build --silent && npm run bundle --silent) >/dev/null \
    || die "The build failed. Run 'npm run build && npm run bundle' to see why."
fi
ok "bundle is current"

# --------------------------------------------------------------------- links

mkdir -p "$BIN_DIR" || die "Cannot create $BIN_DIR"
[ -w "$BIN_DIR" ] || die "$BIN_DIR is not writable. Choose another with --prefix."

for command in "${COMMANDS[@]}"; do
  target="$PROJECT/bin/$command.mjs"
  link="$BIN_DIR/$command"

  [ -f "$target" ] || die "Missing $target"

  # A real file of that name is somebody else's; say so rather than replace it.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    die "$link exists and is not a link. Remove it first, or use --prefix."
  fi

  ln -sfn "$target" "$link"
  ok "$command → ${GREY}${link}${OFF}"
done

# ---------------------------------------------------------------------- PATH

case ":$PATH:" in
  *":$BIN_DIR:"*)
    hash -r 2>/dev/null || true
    resolved="$(command -v diffyard 2>/dev/null || true)"

    if [ "$resolved" = "$BIN_DIR/diffyard" ]; then
      printf '\n'
      if version="$("$BIN_DIR/diffyard" --version 2>/dev/null)"; then
        ok "diffyard ${version} answers from anywhere"
      else
        die "diffyard is linked but will not run. Try: $BIN_DIR/diffyard --version"
      fi
    elif [ -n "$resolved" ]; then
      # Another diffyard earlier on the PATH would win, and the confusion that
      # causes is worth a sentence now.
      printf '\n'
      say "${RED}another diffyard comes first on your PATH:${OFF} $resolved"
      note "the one just linked is $BIN_DIR/diffyard"
    fi
    ;;
  *)
    printf '\n'
    say "$BIN_DIR is not on your PATH yet. Add it:"
    printf '\n    %secho '"'"'export PATH="%s:$PATH"'"'"' >> ~/.bashrc%s\n' "$GREY" "$BIN_DIR" "$OFF"
    note "then open a new shell, or run: source ~/.bashrc"
    ;;
esac

printf '\n  %sTry it:%s  diffyard explore https://example.com/\n\n' "$BOLD" "$OFF"
