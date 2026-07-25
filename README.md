# One Node · Krea 2

A single ComfyUI custom node that replaces a stack of multi-node Krea 2
workflows with one dashboard: prompt, LoRA stack, size presets, seed, and a
two-pass ClownsharK generate (base + same-resolution refine), plus scene
queues, instruction editing and SeedVR2 upscaling.

Architecture follows [one-node-flux-2-klein](https://github.com/lum3on/one-node-flux-2-klein):
the Python side is a placeholder node plus a few REST routes; the frontend
patches an API-format workflow template and submits it through ComfyUI's own
prompt queue. No custom sampling code — model caching, VRAM management, and
execution are all ComfyUI core.

## Install

```bash
git clone https://github.com/Bananavocado/comfyui-krea2-onenode <ComfyUI>/custom_nodes/comfyui-krea2-onenode
```

Then pull in the node packs it depends on — one command, listed below:

```bash
<ComfyUI>/custom_nodes/comfyui-krea2-onenode/install_deps.sh
```

macOS: double-click **Install Dependencies.command** instead. The script finds
`custom_nodes` from its own location, clones or fast-forwards each pack, and
installs their requirements with your ComfyUI python (override with
`PYTHON=/path/to/python`, or pass the `custom_nodes` path as an argument).

Restart ComfyUI. The node appears as **One Node · Krea 2** (category "One Node").

The **✦ Help** button in the node lists every model and node pack below with
direct download links, and marks which packs are already installed.

### Required custom node packs

| Pack | Needed by |
|---|---|
| [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) | all tabs (Power Lora Loader, Seed) |
| [comfyui-krea2edit](https://github.com/lbouaraba/comfyui-krea2edit) | EDIT |
| [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) | T2I, SCENE (ClownsharKSampler_Beta) |
| [ComfyUI-Krea2T-Enhancer](https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer) | T2I, SCENE |
| [ComfyUI_LayerStyle](https://github.com/chflame163/ComfyUI_LayerStyle) | T2I, SCENE (grain) |
| [was-node-suite-comfyui](https://github.com/WASasquatch/was-node-suite-comfyui) | T2I, SCENE (Lucy Sharpen) |
| [ComfyUI-fal-API](https://github.com/gokayfem/ComfyUI-fal-API) | UPSCALE, cloud engine only (paid fal.ai key) |

Everything else the templates use is ComfyUI core — including the whole local
SeedVR2 upscale chain, so that path needs no extra pack at all.

## Models (fixed in the templates)

| Slot | File | From |
|---|---|---|
| Diffusion | `krea2_turbo_bf16.safetensors` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/diffusion_models) |
| Text encoder | `qwen3vl_4b_fp8_scaled.safetensors` (type `krea2`) | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/text_encoders) |
| VAE | `qwen_image_vae.safetensors` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/vae) |
| Identity Edit LoRA (EDIT tab) | `krea2_identity_edit_v1_2.safetensors` | [conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit) |
| SeedVR2 model (UPSCALE, local) | `seedvr2_*.safetensors` → `models/diffusion_models/` | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2/tree/main/diffusion_models) |
| SeedVR2 VAE (UPSCALE, local) | `ema_vae_fp16.safetensors` → `models/vae/` | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2/tree/main/vae) |

To change them, edit `workflows/*.json` (or pick a different model in Settings).

## Usage

1. Add the node (double-click canvas → search "Krea 2").
2. Pick a size preset, type a prompt, optionally add LoRAs (dropdown lists
   your `loras` folder), set seed or leave 🎲 randomize on.
3. **Generate**. Live sampling previews stream into the right panel; the
   final image lands there and (with Auto-save on) in
   `output/krea2-onenode/`.
4. With Auto-save off, results are temporary — click **Save** to keep one.
5. The ADVANCED toggle opens per-pass sampler settings (ClownsharK
   steps/cfg/sampler/scheduler for pass 1; denoise/eta/cfg/sampler/scheduler
   for the same-resolution pass 2) plus the Grain and Sharpen post steps.
   Defaults match the tuned workflow: pass 1 = 8 steps cfg 1 linear/euler +
   simple; pass 2 = denoise 0.2, eta 0.9, exponential/res_2s + bong_tangent.

Tabs: **T2I**, **SCENE** (queue several prompts in one run), **EDIT**
(instruction editing, mask or reference), **UPSCALE** (SeedVR2). UI state
persists in browser localStorage.

UPSCALE runs SeedVR2 two ways, picked with the ENGINE pills:

- **🖥 Local** — SeedVR2 on your own GPU through ComfyUI's core nodes. Free,
  no extra node pack; needs the SeedVR2 model + `ema_vae_fp16` on disk. Scale
  2×/4×/6×/8×, with a VAE tile size to trade speed for VRAM.
- **☁ Cloud** — the same model on fal.ai. Nothing to download, but each image
  is a paid API call and needs a `FAL_KEY` (env var or the fal-api pack's
  `config.ini`). Targets 1080p / 1440p / 2160p.

Both share the drop zone, folder batching and copy-back.

## Apple Silicon (MPS) compatibility

`mps_compat.py` is loaded from `__init__.py` before anything else. MPS has no
float64 support, and several node packs (RES4LYF, ComfyUI core, others) do
unguarded float64 math — so this patches the single chokepoint,
`torch.Tensor.to()`, and silently downcasts float64→float32 *only* when the
target device is MPS. Every other `.to()` call is untouched.

It is a no-op on CUDA/CPU machines (RunPod, Linux servers), so the pack ships
the same everywhere. Disable with `KREA2_NO_MPS_GUARD=1`. The patch is
idempotent — safe if the old standalone `mps-float64-guard` pack is still
installed alongside, though that folder can now be deleted.

## Notes

- Pass-1 negative conditioning is zeroed (`ConditioningZeroOut`), standard
  for turbo/distilled models at cfg 1.
- The node's `image` output replays the last generated image to downstream
  nodes when the graph is run with ComfyUI's own Run button.

## License

[Apache License 2.0](LICENSE) — free to use, modify and redistribute,
commercially included, as long as you keep the license and notices.
The models, LoRAs and node packs it loads carry their own licenses.
