"""
mps_compat — Apple Silicon (MPS) float64 guard.

Merged in from the standalone `mps-float64-guard` custom-node pack so One Node
ships Mac-friendly out of the box (one less folder to install on a fresh
machine / cloud box).

Apple Silicon (MPS) has no float64 support at all — any tensor op that tries
to move or create a float64 tensor on the MPS device raises:

    TypeError: Cannot convert a MPS Tensor to float64 dtype as the MPS
    framework doesn't support float64. Please use float32 instead.

This has been hit inside RES4LYF, ComfyUI core, and several other custom
node packs (WanVideoWrapper, DynamiCrafterWrapper, XLabsSampler, HiDream) —
each has scattered float64 math that was never guarded for MPS. Rather than
patching each file individually (which also gets wiped on every update),
this patches the one true chokepoint: torch.Tensor.to(). Whenever a call
would move/cast a tensor to float64 *on MPS specifically*, it silently
downcasts the request to float32 instead. Every other .to() call anywhere
in the process is completely unaffected.

No-op on non-Mac machines (RunPod/CUDA included) — the patch only installs if
MPS is available. Set KREA2_NO_MPS_GUARD=1 to skip it entirely.
"""

import os

import torch

_PATCH_MARK = "_mps_float64_guard_patched"


def install_mps_float64_guard():
    """Install the torch.Tensor.to() float64→float32 guard. Idempotent."""
    if os.environ.get("KREA2_NO_MPS_GUARD"):
        return

    if getattr(torch.Tensor.to, _PATCH_MARK, False):
        return  # already patched (e.g. reload, or the standalone pack is
        # still installed alongside this one)

    if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
        return  # not on Apple Silicon — do nothing

    _orig_to = torch.Tensor.to

    def _mps_safe_to(self, *args, **kwargs):
        dtype = kwargs.get("dtype")
        device = kwargs.get("device")

        for a in args:
            if isinstance(a, torch.dtype):
                dtype = a
            elif isinstance(a, (torch.device, str)):
                device = a
            elif isinstance(a, torch.Tensor):
                # .to(other_tensor) form — inherit its dtype/device
                dtype = dtype if dtype is not None else a.dtype
                device = device if device is not None else a.device

        # If the call didn't explicitly request a dtype, .to() implicitly
        # keeps the tensor's current dtype -- e.g. `sigmas.to(device)` with
        # sigmas already float64. That implicit case is exactly what was
        # missing before: check self.dtype whenever none was passed in.
        effective_dtype = dtype if dtype is not None else self.dtype

        target_is_mps = (
            (device is not None and (
                device == "mps"
                or (hasattr(device, "type") and device.type == "mps")
            ))
            or (device is None and self.device.type == "mps")
        )

        if target_is_mps and effective_dtype == torch.float64:
            kwargs["dtype"] = torch.float32
            args = tuple(
                torch.float32 if isinstance(a, torch.dtype) else a
                for a in args
            )

        return _orig_to(self, *args, **kwargs)

    setattr(_mps_safe_to, _PATCH_MARK, True)
    torch.Tensor.to = _mps_safe_to

    print("[krea2-onenode] MPS float64 guard active — float64→MPS requests "
          "will be silently downcast to float32.")
