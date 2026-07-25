# One Node · Krea 2

A single ComfyUI custom node that replaces the multi-node Krea 2 two-pass
workflow with one dashboard: prompt, LoRA stack, size presets, seed, and a
two-pass generate (base + latent hi-res refine).

Architecture follows [one-node-flux-2-klein](https://github.com/lum3on/one-node-flux-2-klein):
the Python side is a placeholder node plus a few REST routes; the frontend
patches an API-format workflow template and submits it through ComfyUI's own
prompt queue. No custom sampling code — model caching, VRAM management, and
execution are all ComfyUI core.

## Install

```bash
ln -s /path/to/comfyui-krea2-onenode <ComfyUI>/custom_nodes/comfyui-krea2-onenode
```

Restart ComfyUI. The node appears as **One Node · Krea 2** (category "One Node").

The **✦ Help** button in the node lists every model and node pack below with
direct download links.

### Required custom node packs

| Pack | Needed by |
|---|---|
| [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) | all tabs (Power Lora Loader, Seed) |
| [comfyui-krea2edit](https://github.com/lbouaraba/comfyui-krea2edit) | EDIT |
| [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) | T2I HQ (ClownsharKSampler_Beta) |
| [ComfyUI-Krea2T-Enhancer](https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer) | T2I HQ |
| [ComfyUI_LayerStyle](https://github.com/chflame163/ComfyUI_LayerStyle) | T2I HQ (grain) |
| [was-node-suite-comfyui](https://github.com/WASasquatch/was-node-suite-comfyui) | T2I HQ (Lucy Sharpen) |
| [ComfyUI-fal-API](https://github.com/gokayfem/ComfyUI-fal-API) | UPSCALE (paid fal.ai key) |

Everything else the templates use is ComfyUI core. T2I and SCENE only need
rgthree-comfy.

## Models (fixed in the templates)

| Slot | File | From |
|---|---|---|
| Diffusion | `krea2_turbo_bf16.safetensors` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/diffusion_models) |
| Text encoder | `qwen3vl_4b_fp8_scaled.safetensors` (type `krea2`) | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/text_encoders) |
| VAE | `qwen_image_vae.safetensors` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/vae) |
| Identity Edit LoRA (EDIT tab) | `krea2_identity_edit_v1_2.safetensors` | [conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit) |

To change them, edit `workflows/*.json` (or pick a different model in Settings).

## Usage

1. Add the node (double-click canvas → search "Krea 2").
2. Pick a size preset, type a prompt, optionally add LoRAs (dropdown lists
   your `loras` folder), set seed or leave 🎲 randomize on.
3. **Generate**. Live sampling previews stream into the right panel; the
   final image lands there and (with Auto-save on) in
   `output/krea2-onenode/`.
4. With Auto-save off, results are temporary — click **Save** to keep one.
5. ⚙ opens per-pass sampler settings (steps/cfg/sampler/scheduler,
   pass-2 start step, upscale method/factor). Defaults match the original
   tuned workflow (pass 1: 8 steps cfg 1 euler/simple; pass 2: 10 steps
   cfg 0.8 dpmpp_2m_sde/sgm_uniform, start 5; upscale bislerp ×1.8).

UI state persists in browser localStorage. The greyed mode pills
(I2I, EDIT, …) are placeholders for later phases.

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
