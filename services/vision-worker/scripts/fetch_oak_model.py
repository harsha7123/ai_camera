"""Download the OAK person detector and print the config lines that pin it.

  uv run --with blobconverter python scripts/fetch_oak_model.py [--out models/oak]

Fetches OpenVINO Open Model Zoo "person-detection-retail-0013" (Apache-2.0)
compiled for the OAK's Myriad X (6 SHAVEs) through Luxonis's blobconverter
service, then prints its SHA-256 and the "oak" section for cameras.json. The
worker refuses any blob whose hash differs from the one in the config, so
record the printed hash once and keep it with the site's configuration.

Run it on a machine with internet access, then copy the .blob to the AI box.
Offline alternative: compile the model yourself with OpenVINO 2022.1's
compile_tool for MYRIAD and pin the resulting file's SHA-256 the same way.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

MODEL = "person-detection-retail-0013"
SHAVES = 6


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="models/oak", help="directory for the .blob")
    args = ap.parse_args()
    try:
        import blobconverter  # MIT; only needed for this download
    except ImportError:
        print("blobconverter is not installed: uv run --with blobconverter python scripts/fetch_oak_model.py")
        return 2
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    src = Path(blobconverter.from_zoo(name=MODEL, shaves=SHAVES, zoo_type="intel"))
    dst = out / src.name
    shutil.copyfile(src, dst)
    digest = sha256(dst)
    print(f"saved {dst} ({dst.stat().st_size} bytes)")
    print("add to each OAK camera in cameras.json:")
    print(json.dumps({"oak": {"blob": str(dst), "blob_sha256": digest, "model": MODEL,
                              "nn_size": [544, 320], "person_labels": [1]}}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
