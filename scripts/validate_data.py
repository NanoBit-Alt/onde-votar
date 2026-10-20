#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("path", nargs="?", default="site/data")
ap.add_argument("--allow-demo", action="store_true")
ap.add_argument("--min-changed-sections", type=int, default=1)
a = ap.parse_args()
p = Path(a.path)

for f in ["meta.json", "changes.json", "summary.json"]:
    if not (p / f).exists():
        raise SystemExit(f"faltando {f}")
meta = json.loads((p / "meta.json").read_text(encoding="utf-8"))
changes = json.loads((p / "changes.json").read_text(encoding="utf-8"))
assert isinstance(changes, list)
for c in changes:
    for k in ["id", "uf", "municipio", "zona", "section_map", "new_name"]:
        assert k in c, (k, c)
    for s in c["section_map"]:
        assert s.get("first"), s
assert meta.get("round_from") == 1 and meta.get("round_to") == 2
if meta.get("demo") and not a.allow_demo:
    raise SystemExit("build em modo demo: publicação bloqueada")
count = sum(len(c["section_map"]) for c in changes)
if count < a.min_changed_sections:
    raise SystemExit(f"snapshot suspeito: apenas {count} seções alteradas")
if not meta.get("snapshot_at"):
    raise SystemExit("snapshot sem data/hora")
print("ok", {"groups": len(changes), "changed_sections": count, "demo": meta.get("demo"), "snapshot": meta.get("snapshot_at")})
