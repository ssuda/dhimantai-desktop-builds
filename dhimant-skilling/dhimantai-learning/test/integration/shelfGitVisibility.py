"""Exercise the installed Shelf verifier against real Git transitions inside the course container."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

# The caller supplies checkArguments for the installed history checkpoint.
args = sys.argv[1:]
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp) / "checkout"
    subprocess.run(["git", "clone", "-q", "--no-local", ".", str(root)], check=True)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    expected = hashlib.sha256(("new-checkout\0" + head).encode()).hexdigest()
    metadata, hidden = root / ".git", Path(temp) / "delayed-mount"
    metadata.rename(hidden)
    command = [sys.executable, *args, expected]
    with subprocess.Popen(command, cwd=root, text=True, stdout=subprocess.PIPE) as check:
        try:
            time.sleep(.3)
            assert check.poll() is None, "A briefly missing mount must not reject the checkpoint"
            hidden.rename(metadata)
            time.sleep(.4)
            assert check.poll() is None, "A readable but stale branch must not verify"
            subprocess.run(["git", "switch", "-qc", "new-checkout"], cwd=root, check=True)
            output, _ = check.communicate(timeout=8)
        finally:
            if check.poll() is None:
                check.kill()
    assert check.returncode == 0 and json.loads(output)["answers"]
    subprocess.run(["git", "switch", "-q", "--detach", head], cwd=root, check=True)
    stale = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=15)
    assert stale.returncode != 0 and "could not see the saved Shelf checkout" in stale.stdout
