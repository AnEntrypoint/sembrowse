from __future__ import annotations

import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
source = root / "extension"
output = root / "dist"
version = sys.argv[1] if len(sys.argv) == 2 else "0.1.0"
output.mkdir(exist_ok=True)

for browser in ("chromium", "firefox"):
    target = output / f"sembrowse-{browser}-{version}.zip"
    manifest = json.loads((source / "manifest.json").read_text())
    manifest["version"] = version
    if browser == "chromium":
        manifest.pop("browser_specific_settings")
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(source).as_posix()
            if relative == "manifest.json":
                archive.writestr(relative, json.dumps(manifest, indent=2) + "\n")
            else:
                archive.write(path, relative)
    with ZipFile(target) as archive:
        names = set(archive.namelist())
        required = {"manifest.json", "inference_worker.js", "vendor/wllama/index.js", "vendor/wllama/wasm/wllama.wasm"}
        if required - names:
            raise RuntimeError(f"missing packaged files: {sorted(required - names)}")
    print(target)
