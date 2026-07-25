import glob
import json
import os
import re
import shutil
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
SUBFOLDER = "krea2-onenode"

# Last generated image per node id, set by the JS frontend via /set_output so the
# node's IMAGE output can replay it to downstream nodes.
_last_output_by_node = {}


def _get_output_dir():
    return folder_paths.get_output_directory()


def _resolve_image_file(filename, subfolder="", ftype="output"):
    """Safely resolve a generated image to an absolute path (path-traversal guarded)."""
    if not filename:
        return None
    if ftype == "temp":
        base = Path(folder_paths.get_temp_directory()).resolve()
    elif ftype == "input":
        base = Path(folder_paths.get_input_directory()).resolve()
    else:
        base = Path(_get_output_dir()).resolve()
    target = base
    if subfolder:
        target = target / subfolder
    target = (target / filename).resolve()
    try:
        target.relative_to(base)
    except Exception:
        return None
    return str(target) if os.path.isfile(target) else None


# ---------------------------------------------------------------------------
# REST routes
# ---------------------------------------------------------------------------

def _serve_json(filename):
    async def handler(request):
        path = os.path.join(NODE_DIR, filename)
        if not os.path.exists(path):
            return web.Response(status=404, text=f"{filename} not found")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response(data)
    return handler


PromptServer.instance.routes.get("/krea2_onenode/workflow_quality")(
    _serve_json("workflows/quality_workflow.json"))

PromptServer.instance.routes.get("/krea2_onenode/workflow_upscale")(
    _serve_json("workflows/upscale_workflow.json"))

PromptServer.instance.routes.get("/krea2_onenode/workflow_upscale_local")(
    _serve_json("workflows/upscale_local_workflow.json"))

PromptServer.instance.routes.get("/krea2_onenode/workflow_edit")(
    _serve_json("workflows/edit_workflow.json"))


# ---------------------------------------------------------------------------
# Batch-upscale source folders
# ---------------------------------------------------------------------------

ALLOWED_SRC_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# Folders the user explicitly picked via the native dialog this server session.
# list_folder / read_file / copy_result refuse anything outside them so these
# routes never become an arbitrary-filesystem read/write primitive.
_approved_dirs = set()


def _approved_dir(path_str):
    """Resolve a query path and return it only if it was picked this session."""
    if not path_str:
        return None
    p = Path(path_str).expanduser().resolve()
    return p if p in _approved_dirs else None


@PromptServer.instance.routes.get("/krea2_onenode/pick_folder")
async def pick_folder(request):
    import platform
    import subprocess
    if platform.system() != "Darwin":
        return web.json_response({"ok": False, "error": "native picker is macOS-only"})
    script = ('tell application "System Events" to activate\n'
              'POSIX path of (choose folder with prompt '
              '"Choose a folder of images to upscale")')
    try:
        r = subprocess.run(["osascript", "-e", script],
                           capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return web.json_response({"ok": True, "cancelled": True})
    if r.returncode != 0:  # user hit Cancel
        return web.json_response({"ok": True, "cancelled": True})
    p = Path(r.stdout.strip().rstrip("/")).resolve()
    if not p.is_dir():
        return web.json_response({"ok": False, "error": "not a folder"})
    _approved_dirs.add(p)
    return web.json_response({"ok": True, "path": str(p)})


@PromptServer.instance.routes.get("/krea2_onenode/list_folder")
async def list_folder(request):
    p = _approved_dir(request.query.get("path", ""))
    if not p:
        return web.json_response({"ok": False, "unauthorized": True,
                                  "error": "folder not authorized — choose it again"})
    if not p.is_dir():
        return web.json_response({"ok": False, "error": "folder not found"})
    try:
        files = sorted(f.name for f in p.iterdir()
                       if f.is_file() and f.suffix.lower() in ALLOWED_SRC_EXT
                       and not f.name.startswith("."))
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})
    return web.json_response({"ok": True, "files": files})


@PromptServer.instance.routes.get("/krea2_onenode/read_file")
async def read_file(request):
    folder = _approved_dir(request.query.get("path", ""))
    if not folder:
        return web.json_response({"ok": False, "error": "folder not authorized"}, status=403)
    name = request.query.get("name", "")
    target = (folder / name).resolve()
    if (target.parent != folder or target.suffix.lower() not in ALLOWED_SRC_EXT
            or not target.is_file()):
        return web.json_response({"ok": False, "error": "bad file"}, status=400)
    return web.FileResponse(target)


@PromptServer.instance.routes.post("/krea2_onenode/copy_result")
async def copy_result(request):
    """Copy a finished upscale (output or temp) into <source>/upscaled/."""
    try:
        data = await request.json()
        src = _resolve_image_file(data.get("filename", ""), data.get("subfolder", ""),
                                  data.get("type", "output") or "output")
        if not src:
            return web.json_response({"ok": False, "error": "result file not found"})
        dest_dir = _approved_dir(str(data.get("dest_dir", "")))
        if not dest_dir:
            return web.json_response({"ok": False, "error": "folder not authorized"}, status=403)
        dest_name = os.path.basename(str(data.get("dest_name", "")) or "up_result.png")
        out_dir = dest_dir / "upscaled"
        out_dir.mkdir(exist_ok=True)
        stem = os.path.splitext(dest_name)[0]
        # Keep the RESULT's real format (SaveImage writes .png even when the
        # source was .jpg/.webp).
        ext = os.path.splitext(src)[1] or ".png"
        dest = out_dir / f"{stem}{ext}"
        i = 1
        while dest.exists():
            dest = out_dir / f"{stem}-{i}{ext}"
            i += 1
        shutil.copy2(src, str(dest))
        return web.json_response({"ok": True, "path": str(dest)})
    except Exception as e:
        print(f"[Krea2OneNode] copy_result error: {e}")
        return web.json_response({"ok": False, "error": str(e)})


def _scan_models(key):
    try:
        # Filter macOS AppleDouble/dot files that leak in from external volumes.
        return [f for f in folder_paths.get_filename_list(key)
                if not os.path.basename(f).startswith(".")]
    except Exception:
        return []


@PromptServer.instance.routes.get("/krea2_onenode/models")
async def get_models(request):
    return web.json_response({
        "diffusion_models": _scan_models("diffusion_models"),
        "text_encoders": _scan_models("text_encoders"),
        "vaes": _scan_models("vae"),
        "loras": _scan_models("loras"),
        "upscale_models": _scan_models("upscale_models"),
    })


@PromptServer.instance.routes.post("/krea2_onenode/save_temp")
async def save_temp(request):
    """Copy a temp (PreviewImage) result into the output gallery subfolder.
    Used when auto-save is off and the user clicks Save on a result."""
    try:
        data = await request.json()
        temp_filename = data.get("filename", "")
        temp_subfolder = data.get("subfolder", "")
        prefix = str(data.get("prefix", "") or "Krea2")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", prefix):
            prefix = "Krea2"
        if not temp_filename:
            return web.json_response({"ok": False, "error": "no filename"})

        temp_base = Path(folder_paths.get_temp_directory()).resolve()
        src = (temp_base / temp_subfolder / temp_filename).resolve()
        try:
            src.relative_to(temp_base)
        except Exception:
            return web.json_response({"ok": False, "error": "invalid temp path"}, status=400)
        if not src.exists():
            return web.json_response({"ok": False, "error": f"temp not found: {temp_filename}"})

        dest_dir = os.path.join(_get_output_dir(), SUBFOLDER)
        os.makedirs(dest_dir, exist_ok=True)
        idx = 1
        for f in glob.glob(os.path.join(dest_dir, f"{prefix}_*_.png")):
            try:
                n = int(os.path.basename(f)[len(prefix) + 1:].split("_")[0])
                if n >= idx:
                    idx = n + 1
            except Exception:
                pass
        dest_name = f"{prefix}_{idx:05d}_.png"
        dest_path = os.path.join(dest_dir, dest_name)
        while os.path.exists(dest_path):
            idx += 1
            dest_name = f"{prefix}_{idx:05d}_.png"
            dest_path = os.path.join(dest_dir, dest_name)

        shutil.copy2(str(src), dest_path)
        return web.json_response({"ok": True, "filename": dest_name, "subfolder": SUBFOLDER})
    except Exception as e:
        print(f"[Krea2OneNode] save_temp error: {e}")
        return web.json_response({"ok": False, "error": str(e)})


@PromptServer.instance.routes.post("/krea2_onenode/open_folder")
async def open_folder(request):
    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "")
        ftype = data.get("type", "output") or "output"
        vpath = _resolve_image_file(filename, subfolder, ftype) if filename else None
        if not vpath:
            # No specific file: open the gallery subfolder itself.
            vpath = os.path.join(_get_output_dir(), SUBFOLDER)
            os.makedirs(vpath, exist_ok=True)
        import platform
        import subprocess as _sp
        system = platform.system()
        if system == "Windows":
            if os.path.isfile(vpath):
                _sp.Popen(["explorer", "/select,", vpath.replace("/", "\\")])
            else:
                _sp.Popen(["explorer", vpath.replace("/", "\\")])
        elif system == "Darwin":
            _sp.Popen(["open", "-R", vpath] if os.path.isfile(vpath) else ["open", vpath])
        else:
            _sp.Popen(["xdg-open", vpath if os.path.isdir(vpath) else os.path.dirname(vpath)])
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


@PromptServer.instance.routes.post("/krea2_onenode/set_output")
async def set_output(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id", ""))
        if not node_id:
            return web.json_response({"ok": False, "error": "no node_id"}, status=400)
        fn = data.get("filename")
        if fn:
            _last_output_by_node[node_id] = {
                "filename": fn,
                "subfolder": data.get("subfolder", "") or "",
                "type": data.get("type", "output") or "output",
            }
        else:
            _last_output_by_node.pop(node_id, None)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Placeholder node
# ---------------------------------------------------------------------------

def _empty_image_tensor():
    import torch
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _load_image_tensor(info):
    """Load a stored output image into a ComfyUI IMAGE tensor [1,H,W,3] float32."""
    try:
        import numpy as np
        import torch
        from PIL import Image, ImageOps
    except Exception:
        return _empty_image_tensor()
    if not info:
        return _empty_image_tensor()
    path = _resolve_image_file(info.get("filename", ""), info.get("subfolder", ""), info.get("type", "output"))
    if not path:
        return _empty_image_tensor()
    try:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None, ]
    except Exception:
        return _empty_image_tensor()


class Krea2OneNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {"prompt": ("STRING", {"forceInput": True})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "noop"
    CATEGORY = "One Node"
    OUTPUT_NODE = True

    def noop(self, unique_id=None, **kwargs):
        # Replay the image currently shown in this node's preview (set by JS via
        # POST /krea2_onenode/set_output after each generation).
        info = _last_output_by_node.get(str(unique_id))
        return {"result": (_load_image_tensor(info),)}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


NODE_CLASS_MAPPINGS = {"Krea2OneNode": Krea2OneNode}
NODE_DISPLAY_NAME_MAPPINGS = {"Krea2OneNode": "One Node · Krea 2"}
