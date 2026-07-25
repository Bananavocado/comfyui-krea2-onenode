# Apple Silicon compat patch — must run before any sampling. No-op on
# CUDA/CPU boxes (RunPod etc.); skip with KREA2_NO_MPS_GUARD=1.
from .mps_compat import install_mps_float64_guard

install_mps_float64_guard()

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
