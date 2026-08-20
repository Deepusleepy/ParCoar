from pathlib import Path
import base64, json, zlib

root = Path(__file__).resolve().parents[2]
parts = sorted((root / "tools" / "driving_payload").glob("part-*.b64"))
payload = json.loads(zlib.decompress(base64.b64decode("".join(p.read_text().strip() for p in parts))))
for path, content in payload["files"].items():
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
for path in payload["delete"]:
    target = root / path
    if target.exists():
        target.unlink()
print(f"Applied {len(payload['files'])} files and {len(payload['delete'])} deletions")
