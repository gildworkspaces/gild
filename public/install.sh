#!/bin/sh
# gild installer.
#
#   curl -fsSL https://gild.gg/install.sh | sh
#   curl -fsSL https://gild.gg/install.sh | sh -s -- --version 0.1.2
#
# Installs the `gild` CLI into ~/.gild/bin. No sudo, nothing written outside
# your home directory unless you pass --dir, and re-running it is safe -- it
# replaces the binary in place.
#
# Flags (no environment variables control behaviour):
#   --version X.Y.Z   install an exact version (reads v<X.Y.Z>/manifest.json)
#   --dir <path>      where to install the binary   (default: ~/.gild/bin)
#   --base-url <url>  artifact host, for testing only (default: https://releases.gild.gg)
#   -h, --help        show this help
#
# This script only ever bootstraps: it downloads a single file, verifies its
# sha256 against the published release manifest, and installs it. It does not
# self-update and it does not read configuration from the environment --
# every option is a flag, on purpose, so `curl | sh` behaves the same
# regardless of what is exported in the caller's shell.

set -eu

# --- output -----------------------------------------------------------------
if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m')
  green=$(printf '\033[32m'); reset=$(printf '\033[0m')
else
  bold=''; dim=''; red=''; green=''; reset=''
fi

info() { printf '%s\n' "$*"; }
# shellcheck disable=SC2088 # literal "~/" display prefix, not a tilde expansion
tildify() { case "$1" in "${HOME}"/*) printf '~/%s' "${1#"${HOME}"/}" ;; *) printf '%s' "$1" ;; esac; }
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }

die() {
  printf '%serror:%s %s\n' "$red" "$reset" "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but was not found on PATH."
}

usage() {
  printf 'Usage: install.sh [--version X.Y.Z] [--dir <path>]\n'
  printf '\n'
  printf '  --version X.Y.Z   install an exact version\n'
  printf '  --dir <path>      where to install the binary (default: ~/.gild/bin)\n'
  printf '  --base-url <url>  artifact host, for testing only\n'
  printf '  -h, --help        show this help\n'
}

need uname
need mkdir

# Flatten JSON onto one line so a POSIX sed can pull a string field. Assumes
# the published manifest shape: flat "version"/"tag" strings plus a flat
# "artifacts" object of filename -> sha256.
json_string() {
  tr -d '\n' < "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "Neither sha256sum nor shasum is available; cannot verify the download."
  fi
}

# Everything below runs inside main(), invoked on the very last line. That
# matters for `curl ... | sh`: if the connection drops mid-transfer, sh
# executes whatever bytes arrived. Top-level statements would run half a
# script -- possibly having downloaded but not verified. Defining functions
# and calling main() last means a truncated file defines some functions and
# exits without doing anything.

main() {
  VERSION_PIN=''
  DIR_OPT=''
  BASE_URL_OPT=''

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || die "--version requires an argument, e.g. --version 0.1.0"
        VERSION_PIN="$2"
        shift
        ;;
      --version=*) VERSION_PIN="${1#--version=}" ;;
      --dir)
        [ "$#" -ge 2 ] || die "--dir requires an argument, e.g. --dir /usr/local/gild/bin"
        DIR_OPT="$2"
        shift
        ;;
      --dir=*) DIR_OPT="${1#--dir=}" ;;
      --base-url)
        [ "$#" -ge 2 ] || die "--base-url requires an argument"
        BASE_URL_OPT="$2"
        shift
        ;;
      --base-url=*) BASE_URL_OPT="${1#--base-url=}" ;;
      -h|--help) usage; exit 0 ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    shift
  done

  BASE_URL="${BASE_URL_OPT:-https://releases.gild.gg/cli}"
  DIR="${DIR_OPT:-${HOME}/.gild/bin}"

  # --- platform detection ---------------------------------------------------
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux|Darwin) ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "Windows is not supported by this script." \
          "Run this inside WSL (Windows Subsystem for Linux) instead:" \
          "  wsl --install" \
          "  curl -fsSL https://gild.gg/install.sh | sh"
      ;;
    *)
      die "Unrecognised operating system: ${os}" \
          "gild publishes builds for macOS and Linux only."
      ;;
  esac

  case "${os}/${arch}" in
    Darwin/x86_64|Darwin/amd64)   PLATFORM='darwin-x64' ;;
    Darwin/arm64|Darwin/aarch64)  PLATFORM='darwin-arm64' ;;
    Linux/x86_64|Linux/amd64)     PLATFORM='linux-x64' ;;
    *)
      die "Unsupported platform: ${os} ${arch}" \
          "gild currently publishes: macOS x86_64, macOS arm64, Linux x86_64." \
          "" \
          "Include this when reporting:" \
          "  uname -a: $(uname -a 2>/dev/null || echo unavailable)" \
          "  https://github.com/gildforge/cli/issues"
      ;;
  esac

  # Under Rosetta 2, `uname -m` reports x86_64 on an Apple Silicon Mac; correct it.
  if [ "$PLATFORM" = 'darwin-x64' ] && \
     [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = '1' ]; then
    PLATFORM='darwin-arm64'
    info "  Detected Rosetta 2; installing the native arm64 build."
  fi

  # --- downloader -------------------------------------------------------------
  case "$BASE_URL" in
    https://*) https_only=1 ;;
    http://*)  https_only=0 ;;
    *) die "Unsupported --base-url scheme (must be http:// or https://): ${BASE_URL}" ;;
  esac

  if command -v curl >/dev/null 2>&1; then
    if [ "$https_only" -eq 1 ]; then
      fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
    else
      fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$https_only" -eq 1 ]; then
      fetch() { wget -q --https-only --tries=3 -O "$2" "$1"; }
    else
      fetch() { wget -q --tries=3 -O "$2" "$1"; }
    fi
  else
    die "Either curl or wget is required."
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t gild-install)
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT INT TERM HUP

  # --- version resolution ---------------------------------------------------
  if [ -n "$VERSION_PIN" ]; then
    case "$VERSION_PIN" in v*) VERSION_PIN="${VERSION_PIN#v}" ;; esac
    TAG="v${VERSION_PIN}"
    step "Resolving gild ${TAG}"
    fetch "${BASE_URL}/${TAG}/manifest.json" "${tmp}/manifest.json" || die \
      "Could not download the gild ${TAG} manifest:" \
      "  ${BASE_URL}/${TAG}/manifest.json"
    VERSION="$VERSION_PIN"
  else
    step "Resolving gild version"
    fetch "${BASE_URL}/latest.json" "${tmp}/manifest.json" || die \
      "Could not resolve the latest gild version from ${BASE_URL}/latest.json." \
      "Check your network, or pin a version:" \
      "  curl -fsSL https://gild.gg/install.sh | sh -s -- --version 0.1.0"
    VERSION=$(json_string "${tmp}/manifest.json" version)
    [ -n "$VERSION" ] || die "Could not read version from the gild manifest."
    TAG=$(json_string "${tmp}/manifest.json" tag)
    [ -n "$TAG" ] || TAG="v${VERSION}"
    fetch "${BASE_URL}/${TAG}/manifest.json" "${tmp}/manifest.json" || die \
      "Could not download the gild ${TAG} manifest."
  fi

  ARTIFACT="gild-${PLATFORM}"
  ARTIFACT_SHA=$(json_string "${tmp}/manifest.json" "$ARTIFACT")
  if [ -z "$ARTIFACT_SHA" ]; then
    die "This release (${TAG}) has no CLI build for ${PLATFORM}." \
        "Available releases: https://github.com/gildforge/cli/releases"
  fi

  info ""
  info "  ${bold}gild${reset} ${TAG}"
  info "  ${dim}${PLATFORM}${reset}"
  info "  ${dim}$(tildify "$DIR")${reset}"
  info ""

  ARTIFACT_URL="${BASE_URL}/${TAG}/${ARTIFACT}"

  # --- download + verify -------------------------------------------------------
  step "Downloading ${ARTIFACT}"
  fetch "$ARTIFACT_URL" "${tmp}/gild" || die \
    "Download failed: ${ARTIFACT_URL}" \
    "That version may not publish a CLI build for ${PLATFORM}."

  step "Verifying checksum"
  actual=$(sha256_file "${tmp}/gild")
  if [ "$ARTIFACT_SHA" != "$actual" ]; then
    rm -f "${tmp}/gild"
    die "Checksum mismatch for gild -- refusing to install." \
        "expected: ${ARTIFACT_SHA}" \
        "actual:   ${actual}" \
        "" \
        "This can mean a corrupted download, or a tampered artifact." \
        "Please report it: https://github.com/gildforge/cli/issues"
  fi

  # --- install ------------------------------------------------------------------
  step "Installing to $(tildify "$DIR")"
  mkdir -p "$DIR"
  chmod 755 "${tmp}/gild"
  mv -f "${tmp}/gild" "${DIR}/.gild.tmp"
  mv -f "${DIR}/.gild.tmp" "${DIR}/gild"

  installed_version=$("${DIR}/gild" --version 2>/dev/null || echo '')

  # --- PATH -----------------------------------------------------------------
  already_on_path=0
  case ":${PATH}:" in *":${DIR}:"*) already_on_path=1 ;; esac

  if [ "${DIR#"${HOME}/"}" != "$DIR" ]; then
    path_literal="\$HOME/${DIR#"${HOME}"/}"
  else
    path_literal="$DIR"
  fi

  shell_name=$(basename "${SHELL:-sh}")
  added_to=''

  append_profile() {
    target_file="$1"
    target_line="$2"
    [ -e "$target_file" ] || touch "$target_file" 2>/dev/null || return 0
    [ -w "$target_file" ] || return 0
    grep -Fq "$DIR" "$target_file" 2>/dev/null && return 0
    printf '\n# gild\n%s\n' "$target_line" >> "$target_file" || return 0
    added_to="${added_to} ${target_file##*/}"
  }

  if [ "$already_on_path" -eq 0 ]; then
    case "$shell_name" in
      fish)
        fish_config="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/config.fish"
        mkdir -p "$(dirname "$fish_config")" 2>/dev/null || true
        append_profile "$fish_config" "set -gx PATH ${path_literal} \$PATH"
        ;;
      zsh)
        append_profile "${ZDOTDIR:-$HOME}/.zshrc" "export PATH=\"${path_literal}:\$PATH\""
        ;;
      bash)
        for f in "${HOME}/.bashrc" "${HOME}/.bash_profile"; do
          [ -f "$f" ] && append_profile "$f" "export PATH=\"${path_literal}:\$PATH\""
        done
        [ -z "$added_to" ] && append_profile "${HOME}/.bashrc" "export PATH=\"${path_literal}:\$PATH\""
        ;;
      *)
        append_profile "${HOME}/.profile" "export PATH=\"${path_literal}:\$PATH\""
        ;;
    esac
  fi

  # --- done -------------------------------------------------------------------
  info ""
  info "  ${green}Installed${reset} ${installed_version:-gild ${TAG}}"
  info ""

  if [ "$already_on_path" -eq 1 ]; then
    info "  Run ${bold}gild init${reset} to create your identity."
  elif [ -n "$added_to" ]; then
    info "  Added to PATH in:${added_to}"
    info "  Restart your shell, or run:"
    info ""
    info "    ${bold}export PATH=\"${DIR}:\$PATH\"${reset}"
  else
    info "  Add this to your shell profile:"
    info ""
    info "    ${bold}export PATH=\"${DIR}:\$PATH\"${reset}"
  fi
  info ""
}

main "$@"
