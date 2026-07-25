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

Requires [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)
(Power Lora Loader + Seed nodes used by the workflow template).

## Models (fixed in the template)

| Slot | File |
|---|---|
| Diffusion | `krea2_turbo_bf16.safetensors` |
| Text encoder | `qwen3vl_4b_fp8_scaled.safetensors` (type `krea2`) |
| VAE | `qwen_image_vae.safetensors` |

To change them, edit `workflows/generate_workflow.json`.

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
