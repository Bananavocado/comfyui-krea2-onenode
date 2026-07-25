#!/usr/bin/env bash
# One Node · Krea 2 — dependency installer
#
# Clones (or updates) every custom node pack the workflow templates need, then
# installs each pack's Python requirements. Safe to re-run: existing checkouts
# are fast-forwarded, never clobbered.
#
#   ./install_deps.sh                  # auto-detect custom_nodes from this script's location
#   ./install_deps.sh /path/custom_nodes
#   PYTHON=/path/to/venv/bin/python ./install_deps.sh
#   SKIP_PIP=1 ./install_deps.sh       # clone only, no pip
#
# macOS: double-click "Install Dependencies.command" instead.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── where do the packs go? ───────────────────────────────────────────────────
# When installed normally this script lives at custom_nodes/<pack>/install_deps.sh,
# so the parent of our own folder is custom_nodes.
CUSTOM_NODES="${1:-}"
if [ -z "$CUSTOM_NODES" ]; then
  parent="$(dirname "$SCRIPT_DIR")"
  if [ "$(basename "$parent")" = "custom_nodes" ]; then
    CUSTOM_NODES="$parent"
  elif [ -n "${COMFYUI_PATH:-}" ] && [ -d "$COMFYUI_PATH/custom_nodes" ]; then
    CUSTOM_NODES="$COMFYUI_PATH/custom_nodes"
  fi
fi

if [ -z "$CUSTOM_NODES" ] || [ ! -d "$CUSTOM_NODES" ]; then
  echo "!! Could not find your ComfyUI custom_nodes folder."
  echo "   Pass it explicitly:  ./install_deps.sh /path/to/ComfyUI/custom_nodes"
  echo "   (or set COMFYUI_PATH=/path/to/ComfyUI)"
  exit 1
fi

# ── python for pip installs ──────────────────────────────────────────────────
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then
    PY="$VIRTUAL_ENV/bin/python"
  else
    # ComfyUI installs commonly keep a venv next to the ComfyUI folder
    for cand in \
      "$(dirname "$CUSTOM_NODES")/venv/bin/python" \
      "$(dirname "$CUSTOM_NODES")/.venv/bin/python" \
      "$(dirname "$(dirname "$CUSTOM_NODES")")/venv/bin/python" \
      "$(dirname "$(dirname "$CUSTOM_NODES")")/.venv/bin/python"; do
      [ -x "$cand" ] && { PY="$cand"; break; }
    done
  fi
fi
[ -z "$PY" ] && PY="$(command -v python3 || command -v python || true)"

# ── the packs ────────────────────────────────────────────────────────────────
# "<dir>|<git url>|<what needs it>"
PACKS=(
  "rgthree-comfy|https://github.com/rgthree/rgthree-comfy|all tabs (Power Lora Loader, Seed)"
  "comfyui-krea2edit|https://github.com/lbouaraba/comfyui-krea2edit|EDIT"
  "RES4LYF|https://github.com/ClownsharkBatwing/RES4LYF|T2I HQ (ClownsharKSampler_Beta)"
  "ComfyUI-Krea2T-Enhancer|https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer|T2I HQ"
  "comfyui_layerstyle|https://github.com/chflame163/ComfyUI_LayerStyle|T2I HQ (AddGrain)"
  "was-node-suite-comfyui|https://github.com/WASasquatch/was-node-suite-comfyui|T2I HQ (Lucy Sharpen)"
  "fal-api|https://github.com/gokayfem/ComfyUI-fal-API|UPSCALE (needs a fal.ai key)"
)

echo "One Node · Krea 2 — installing dependencies"
echo "  custom_nodes : $CUSTOM_NODES"
echo "  python       : ${PY:-<none found — pip steps will be skipped>}"
echo

OK=(); FAILED=()

for entry in "${PACKS[@]}"; do
  IFS='|' read -r dir url need <<< "$entry"
  target="$CUSTOM_NODES/$dir"
  echo "── $dir  ($need)"

  if [ -d "$target/.git" ]; then
    echo "   already installed — updating"
    if ! git -C "$target" pull --ff-only; then
      echo "   !! pull failed (local changes?) — leaving it alone"
      FAILED+=("$dir (pull)")
      continue
    fi
  elif [ -d "$target" ]; then
    echo "   folder exists but is not a git checkout — skipping"
    FAILED+=("$dir (not a git checkout)")
    continue
  else
    if ! git clone --depth 1 "$url" "$target"; then
      echo "   !! clone failed"
      FAILED+=("$dir (clone)")
      continue
    fi
  fi

  if [ -z "${SKIP_PIP:-}" ] && [ -n "$PY" ] && [ -f "$target/requirements.txt" ]; then
    echo "   installing requirements"
    if ! "$PY" -m pip install -r "$target/requirements.txt"; then
      echo "   !! pip install failed"
      FAILED+=("$dir (pip)")
      continue
    fi
  fi

  OK+=("$dir")
done

echo
echo "Installed/updated: ${#OK[@]}/${#PACKS[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Needs attention:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
fi

cat <<'NOTE'

Next steps
  1. Restart ComfyUI so the new packs load.
  2. UPSCALE tab only: put your fal.ai key in custom_nodes/fal-api/config.ini
     (FAL_KEY = ...) or export FAL_KEY. Those calls are paid, per image.
  3. Models: open the node and click ✦ Help for every download link.
NOTE

[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0
