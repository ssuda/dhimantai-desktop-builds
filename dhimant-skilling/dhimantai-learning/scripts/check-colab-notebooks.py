"""Check generated Colab notebook semantics with CPU PyTorch; this is not TPU acceptance.

Usage: python scripts/check-colab-notebooks.py /path/to/generated/colab
"""
import contextlib
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import torch

folder = Path(sys.argv[1])
notebooks = sorted(folder.glob("*.ipynb"))
assert len(notebooks) == 8
assert not hasattr(torch, "tpu"), "Run this offline check with CPU PyTorch"

setup = json.loads(notebooks[0].read_text())["cells"][1]["source"]
scope = {"_dhimantai_tpu_ready": True}
try:
    exec(setup, scope)
except RuntimeError as error:
    assert "TorchTPU is missing" in str(error)
else:
    raise AssertionError("CPU-only kernel was reported as a TPU")
assert scope["_dhimantai_tpu_ready"] is False

# A registered backend with unusable hardware must also leave setup failed.
torch.tpu = SimpleNamespace(precision=lambda _: contextlib.nullcontext(), Precision=SimpleNamespace(HIGHEST=1))
try:
    try:
        exec(setup, scope)
    except RuntimeError as error:
        assert "No CPU fallback" in str(error)
    else:
        raise AssertionError("An invalid TPU device was accepted")
    assert scope["_dhimantai_tpu_ready"] is False

    for path in notebooks[1:]:
        cells = json.loads(path.read_text())["cells"]
        code = [cell["source"] for cell in cells if cell["cell_type"] == "code" and cell["id"] != "colab-tpu-setup"]
        # A lesson cannot execute when setup was skipped or failed.
        try:
            exec(code[0], {"_dhimantai_tpu_ready": False})
        except RuntimeError as error:
            assert "Run the TPU setup cell" in str(error)
        else:
            raise AssertionError("Lesson executed before setup")

        # Deliberately substitute CPU only in this test to verify cell scoping,
        # lesson assertions, and independence between notebook kernels.
        scope = {"torch": torch, "DEVICE": torch.device("cpu"), "_dhimantai_tpu_ready": True}
        with contextlib.redirect_stdout(io.StringIO()):
            for source in code:
                exec(source, scope)
        assert torch.get_default_device().type == "cpu"
        print(f"PASS CPU semantics: {path.name}")
finally:
    del torch.tpu
print("PASS missing/unusable TPU and skipped-setup guards. Real TPU execution not exercised.")
