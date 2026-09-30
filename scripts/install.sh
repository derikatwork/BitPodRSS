#!/usr/bin/env bash
# BitPodRSS installer for Debian / Ubuntu (and derivatives).
#
#   From a clone:   ./scripts/install.sh
#   From scratch:   curl -fsSL https://raw.githubusercontent.com/derikatwork/BitPodRSS/main/scripts/install.sh | bash
#
# Options:  --no-ffmpeg   skip ffmpeg (local transcription will be unavailable)
#           --dir PATH    where to clone when not run from a clone (default: ./BitPodRSS)
#           --no-build    skip the production build
#           -h, --help
#
# It only installs what is missing, never touches an existing suitable Node, and installs Node via nvm
# (in your home directory, no sudo) when the system Node is absent or older than 22.19.
set -euo pipefail

REPO_URL="https://github.com/derikatwork/BitPodRSS.git"
NVM_VERSION="v0.40.1"
MIN_NODE="22.19.0"
WANT_FFMPEG=1
DO_BUILD=1
TARGET_DIR="./BitPodRSS"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-ffmpeg) WANT_FFMPEG=0 ;;
    --no-build)  DO_BUILD=0 ;;
    --dir)       shift; [ $# -gt 0 ] || die "--dir needs a path"; TARGET_DIR="$1" ;;
    -h|--help)   sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# --- 0. sanity -------------------------------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "This installer targets Debian/Ubuntu Linux. See the README for other systems."
command -v apt-get >/dev/null 2>&1 || die "apt-get not found. This installer supports Debian-based distributions only."
[ "$(id -u)" -ne 0 ] || warn "Running as root. It works, but running as your normal user is recommended."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages (git, curl, ffmpeg). Install sudo or run as root."
  SUDO="sudo"
fi

# --- 1. system packages (only what is missing) ----------------------------------------------------
missing=()
command -v git  >/dev/null 2>&1 || missing+=(git)
command -v curl >/dev/null 2>&1 || missing+=(curl)
[ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
if [ "$WANT_FFMPEG" -eq 1 ] && ! command -v ffmpeg >/dev/null 2>&1; then missing+=(ffmpeg); fi

if [ ${#missing[@]} -gt 0 ]; then
  say "Installing system packages: ${missing[*]}"
  $SUDO apt-get update -y
  $SUDO apt-get install -y "${missing[@]}"
else
  say "System packages already present"
fi

# --- 2. Node.js >= 22.19 ---------------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const need = process.argv[1].split(".").map(Number);
    const have = process.versions.node.split(".").map(Number);
    for (let i = 0; i < 3; i++) { if (have[i] > need[i]) process.exit(0); if (have[i] < need[i]) process.exit(1); }
  ' "$MIN_NODE"
}

if node_ok; then
  say "Node $(node --version) is new enough"
else
  [ -z "$(command -v node || true)" ] || warn "Found Node $(node --version), but $MIN_NODE or newer is required. Installing Node 22 with nvm (your system Node is left untouched)."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say "Installing nvm $NVM_VERSION"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
  fi
  # nvm's scripts are not written for `set -u`
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  say "Installing Node 22"
  nvm install 22
  nvm use 22 >/dev/null
  set -u
  node_ok || die "Node $(node --version) is still older than $MIN_NODE."
  NVM_NOTE=1
fi

# --- 3. get the code --------------------------------------------------------------------------------
if [ -f package.json ] && grep -q '"name": "bitpodrss"' package.json; then
  say "Using the existing checkout in $(pwd)"
elif [ -d "$TARGET_DIR/.git" ]; then
  say "Updating $TARGET_DIR"
  git -C "$TARGET_DIR" pull --ff-only
  cd "$TARGET_DIR"
else
  say "Cloning into $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

# --- 4. dependencies and build ---------------------------------------------------------------------
say "Installing dependencies (npm install)"
npm install --no-audit --no-fund

if [ "$DO_BUILD" -eq 1 ]; then
  say "Building the app"
  npm run build
fi

# --- 5. report -------------------------------------------------------------------------------------
say "Checking optional features"
if command -v ffmpeg >/dev/null 2>&1; then echo "  ffmpeg:                 found"; else echo "  ffmpeg:                 NOT found (local transcription disabled)"; fi
if [ -d node_modules/@huggingface/transformers ]; then echo "  transcription engine:   installed"; else echo "  transcription engine:   NOT installed (run: npm install @huggingface/transformers)"; fi

echo
echo "BitPodRSS is installed in: $(pwd)"
echo
echo "Start it:"
if [ "${NVM_NOTE:-0}" = "1" ]; then
  echo "  (new terminal, or:  . \"$NVM_DIR/nvm.sh\" && nvm use 22)"
fi
echo "  cd \"$(pwd)\" && npm run serve"
echo
echo "Then open http://localhost:8787  (next steps: README > Installation and setup walkthrough, step 3)"
