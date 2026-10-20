#!/usr/bin/env python3
"""Build do site: lista oficial de seções alteradas 1º→2º turno + cadastro nacional 2026.

Princípios:
- não compara 2024×2026;
- pesquisa sempre pela seção usada no 1º turno;
- suporta renumeração de seção;
- preserva metadados do snapshot para não confundir capturas diferentes do painel do TSE.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests

CKAN = "https://dadosabertos.tse.jus.br/api/3/action/package_show?id=eleitorado-2026"
FALLBACK = "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip"
UA = "OndeVotoAgora/3.0 (+GitHub Pages; dados públicos TSE)"

LOC_ALIASES = {
    "round": ["NR_TURNO", "TURNO"],
    "uf": ["SG_UF", "UF"],
    "mun_code": ["CD_MUNICIPIO", "CODIGO_MUNICIPIO", "COD_MUNICIPIO"],
    "municipio": ["NM_MUNICIPIO", "MUNICIPIO", "NOME_MUNICIPIO"],
    "zona": ["NR_ZONA", "ZONA", "ZONA_ELEITORAL", "NR_ZONA_ELEITORAL"],
    "secao": ["NR_SECAO", "SECAO", "SECAO_ELEITORAL", "NR_SECAO_ELEITORAL"],
    "local_id": ["NR_LOCAL_VOTACAO", "LOCAL_VOTACAO", "COD_LOCAL_VOTACAO", "CD_LOCAL_VOTACAO"],
    "name": ["NM_LOCAL_VOTACAO", "NOME_LOCAL_VOTACAO", "LOCAL_DE_VOTACAO"],
    "address": ["DS_ENDERECO", "DS_LOCAL_VOTACAO_ENDERECO", "ENDERECO", "ENDERECO_LOCAL_VOTACAO"],
    "bairro": ["NM_BAIRRO", "BAIRRO"],
    "cep": ["NR_CEP", "CEP"],
    "lat": ["NR_LATITUDE", "LATITUDE"],
    "lng": ["NR_LONGITUDE", "LONGITUDE"],
}

# O relatório do SIG/APEX muda rótulos entre versões. Por isso aceitamos tanto nomes técnicos
# quanto títulos humanos exportados em CSV/XLSX.
CHG_ALIASES = {
    "uf": ["SG_UF", "UF", "UNIDADE_FEDERACAO", "UNIDADE_DA_FEDERACAO"],
    "municipio": ["NM_MUNICIPIO", "MUNICIPIO", "NOME_MUNICIPIO"],
    "zona": ["NR_ZONA", "ZONA", "ZONA_ELEITORAL", "NR_ZONA_ELEITORAL"],
    "s1": [
        "NR_SECAO_1T", "NR_SECAO_1_TURNO", "SECAO_1T", "SECAO_1_TURNO",
        "SECAO_1_TURNO", "SECAO_PRIMEIRO_TURNO", "NR_SECAO", "SECAO", "SECAO_ELEITORAL",
    ],
    "s2": [
        "NR_SECAO_2T", "NR_SECAO_2_TURNO", "SECAO_2T", "SECAO_2_TURNO",
        "SECAO_SEGUNDO_TURNO", "NOVA_SECAO", "SECAO_DESTINO",
    ],
    "old_id": [
        "NR_LOCAL_VOTACAO_1T", "NR_LOCAL_VOTACAO_1_TURNO",
        "NR_LOCAL_ANTERIOR", "NR_LOCAL_VOTACAO_ANTERIOR", "CD_LOCAL_ORIGEM", "NR_LOCAL_ORIGEM",
    ],
    "new_id": [
        "NR_LOCAL_VOTACAO_2T", "NR_LOCAL_VOTACAO_2_TURNO",
        "NR_NOVO_LOCAL", "NR_LOCAL_VOTACAO_NOVO", "CD_LOCAL_DESTINO", "NR_LOCAL_DESTINO",
    ],
    "old_name": [
        "NM_LOCAL_VOTACAO_1T", "NM_LOCAL_VOTACAO_1_TURNO", "NOME_LOCAL_1T",
        "LOCAL_VOTACAO_ANTERIOR", "LOCAL_ANTERIOR", "LOCAL_ANTERIOR_NOME", "LOCAL_DE_VOTACAO_1_TURNO",
        "LOCAL_DE_VOTACAO_PRIMEIRO_TURNO", "LOCAL_1_TURNO", "LOCAL_1T", "LOCAL_ORIGEM", "LOCAL_ORIGEM_NOME",
    ],
    "new_name": [
        "NM_LOCAL_VOTACAO_2T", "NM_LOCAL_VOTACAO_2_TURNO", "NOME_LOCAL_2T",
        "NOVO_LOCAL_VOTACAO", "NOVO_LOCAL", "NOVO_LOCAL_NOME", "LOCAL_DE_VOTACAO_2_TURNO",
        "LOCAL_DE_VOTACAO_SEGUNDO_TURNO", "LOCAL_2_TURNO", "LOCAL_2T", "LOCAL_DESTINO", "LOCAL_DESTINO_NOME",
    ],
    "old_address": [
        "DS_ENDERECO_1T", "DS_ENDERECO_1_TURNO", "ENDERECO_1T", "ENDERECO_ANTERIOR",
        "ENDERECO_1_TURNO", "ENDERECO_PRIMEIRO_TURNO", "DS_ENDERECO_ANTERIOR",
    ],
    "new_address": [
        "DS_ENDERECO_2T", "DS_ENDERECO_2_TURNO", "ENDERECO_2T", "NOVO_ENDERECO",
        "ENDERECO_2_TURNO", "ENDERECO_SEGUNDO_TURNO", "DS_NOVO_ENDERECO",
    ],
    "eleitores": ["QT_ELEITORES", "QTD_ELEITORES", "ELEITORADO", "QUANTIDADE_ELEITORES", "QT_ELEITORADO"],
}


def norm(s):
    s = "" if pd.isna(s) else str(s)
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^A-Z0-9]+", " ", s.upper()).strip()


def intstr(v):
    if v is None or pd.isna(v):
        return ""
    s = str(v).strip()
    try:
        return str(int(float(s.replace(",", "."))))
    except ValueError:
        return re.sub(r"\D", "", s) or s


def number(v):
    if v is None or pd.isna(v):
        return None
    try:
        return float(str(v).strip().replace(",", "."))
    except Exception:
        return None


def choose(cols: Iterable[str], aliases: list[str]):
    cmap = {norm(c).replace(" ", "_"): c for c in cols}
    for a in aliases:
        k = norm(a).replace(" ", "_")
        if k in cmap:
            return cmap[k]
    return None


def read_csv_bytes(raw: bytes):
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        for sep in (";", ",", "\t"):
            try:
                df = pd.read_csv(io.BytesIO(raw), sep=sep, encoding=enc, dtype=str, low_memory=False)
                if len(df.columns) > 3:
                    return df
            except Exception:
                pass
    raise RuntimeError("CSV não reconhecido")


def read_table(path: Path):
    raw = path.read_bytes()
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(io.BytesIO(raw), dtype=str)
    if suffix == ".zip":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = z.namelist()
            csvs = [n for n in names if n.lower().endswith(".csv")]
            excels = [n for n in names if n.lower().endswith((".xlsx", ".xls"))]
            if csvs:
                return read_csv_bytes(z.read(csvs[0]))
            if excels:
                return pd.read_excel(io.BytesIO(z.read(excels[0])), dtype=str)
            raise RuntimeError("ZIP sem CSV/XLSX")
    return read_csv_bytes(raw)


def discover_locations_url():
    try:
        r = requests.get(CKAN, headers={"User-Agent": UA}, timeout=30)
        r.raise_for_status()
        for res in r.json()["result"]["resources"]:
            name = str(res.get("name", "")).lower()
            if "local de votação" in name and "2026" in name:
                return res["url"]
    except Exception as exc:
        print("[aviso] CKAN:", exc)
    return FALLBACK


def download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1000:
        return
    with requests.get(url, headers={"User-Agent": UA}, stream=True, timeout=180) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)


def _read_location_csv(raw: bytes):
    last_error = None
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        for sep in (";", ",", "\t"):
            try:
                head = pd.read_csv(io.BytesIO(raw), sep=sep, encoding=enc, dtype=str, nrows=0)
                if len(head.columns) <= 3:
                    continue
                sel = {k: choose(head.columns, aliases) for k, aliases in LOC_ALIASES.items()}
                missing = [k for k in ("uf", "municipio", "zona", "secao", "local_id", "name") if not sel[k]]
                if missing:
                    continue
                usecols = sorted({c for c in sel.values() if c})
                df = pd.read_csv(io.BytesIO(raw), sep=sep, encoding=enc, dtype=str, usecols=usecols, low_memory=False)
                out = pd.DataFrame({k: (df[c] if c else "") for k, c in sel.items()})
                for c in ("round", "zona", "secao", "local_id", "mun_code"):
                    out[c] = out[c].map(intstr)
                for c in ("uf", "municipio", "name", "address", "bairro", "cep"):
                    out[c] = out[c].fillna("").astype(str).str.strip()
                out["uf"] = out["uf"].str.upper()
                out["lat"] = out["lat"].map(number)
                out["lng"] = out["lng"].map(number)
                return out
            except Exception as exc:
                last_error = exc
    raise RuntimeError(f"CSV de locais não reconhecido: {last_error}")


def read_locations(path: Path):
    if path.suffix.lower() == ".zip":
        frames = []
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".csv") and not n.startswith("__MACOSX")]
            for name in names:
                try:
                    frames.append(_read_location_csv(z.read(name)))
                except RuntimeError:
                    continue
        if not frames:
            raise RuntimeError("ZIP de locais sem CSV compatível")
        out = pd.concat(frames, ignore_index=True)
    else:
        out = _read_location_csv(path.read_bytes())

    # Quando o cadastro traz os dois turnos, o site deve exibir o local vigente no 2º turno.
    rounds = {x for x in out["round"].unique() if x}
    if "2" in rounds:
        out = out[out["round"] == "2"].copy()

    return out[(out.uf != "ZZ") & (out.zona != "") & (out.secao != "")].drop_duplicates(
        ["uf", "mun_code", "zona", "secao"], keep="last"
    )


def read_changes(path: Path):
    df = read_table(path)
    sel = {k: choose(df.columns, aliases) for k, aliases in CHG_ALIASES.items()}
    missing = [k for k in ("uf", "zona", "s1") if not sel[k]]
    if missing:
        raise RuntimeError(f"Colunas de alterações ausentes: {missing}; disponíveis={list(df.columns)}")
    out = pd.DataFrame({k: (df[c] if c else "") for k, c in sel.items()})
    for c in ("zona", "s1", "s2", "old_id", "new_id", "eleitores"):
        out[c] = out[c].map(intstr)
    out["s2"] = out.apply(lambda r: r.s2 or r.s1, axis=1)
    for c in ("uf", "municipio", "old_name", "new_name", "old_address", "new_address"):
        out[c] = out[c].fillna("").astype(str).str.strip()
    out["uf"] = out["uf"].str.upper()
    out = out[(out.uf != "") & (out.zona != "") & (out.s1 != "")]
    return out.drop_duplicates(["uf", "zona", "s1"], keep="last")


def load_snapshot_meta(meta_path: Path | None, changes_path: Path):
    meta = {}
    if meta_path and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print("[aviso] meta do snapshot inválido:", exc)
    meta.setdefault("source_url", "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/painel-capilaridade")
    meta.setdefault("fetched_at", datetime.now(timezone.utc).isoformat())
    meta.setdefault("sha256", hashlib.sha256(changes_path.read_bytes()).hexdigest())
    return meta


def best_location_by_id(loc_by_id, uf, zona, local_id):
    if not local_id:
        return None
    rows = loc_by_id.get((uf, zona, local_id)) or []
    if not rows:
        return None
    # Prefere registro com coordenada e endereço preenchidos.
    return max(rows, key=lambda r: (r.lat is not None and r.lng is not None, bool(r.address), bool(r.name)))


def build(chg, loc, out: Path, snapshot_meta: dict, demo: bool = False):
    out.mkdir(parents=True, exist_ok=True)
    (out / "sections").mkdir(exist_ok=True)
    (out / "locations").mkdir(exist_ok=True)

    by_section = {(r.uf, r.zona, r.secao): r for r in loc.itertuples(index=False)}
    by_local = {}
    for r in loc.itertuples(index=False):
        by_local.setdefault((r.uf, r.zona, r.local_id), []).append(r)

    rows = []
    for r in chg.itertuples(index=False):
        current = by_section.get((r.uf, r.zona, r.s2))
        new_loc = best_location_by_id(by_local, r.uf, r.zona, r.new_id) or current
        old_loc = best_location_by_id(by_local, r.uf, r.zona, r.old_id)

        municipio = r.municipio or (new_loc.municipio if new_loc is not None else "") or (
            old_loc.municipio if old_loc is not None else ""
        )
        rows.append(
            {
                "uf": r.uf,
                "municipio": municipio,
                "zona": r.zona,
                "s1": r.s1,
                "s2": r.s2,
                "old_id": r.old_id or (old_loc.local_id if old_loc is not None else ""),
                "new_id": r.new_id or (new_loc.local_id if new_loc is not None else ""),
                "old_name": r.old_name or (old_loc.name if old_loc is not None else ""),
                "new_name": r.new_name or (new_loc.name if new_loc is not None else ""),
                "old_address": r.old_address or (old_loc.address if old_loc is not None else ""),
                "new_address": r.new_address or (new_loc.address if new_loc is not None else ""),
                "old_lat": old_loc.lat if old_loc is not None else None,
                "old_lng": old_loc.lng if old_loc is not None else None,
                "new_lat": new_loc.lat if new_loc is not None else None,
                "new_lng": new_loc.lng if new_loc is not None else None,
                "eleitores": intstr(r.eleitores),
            }
        )
    ch = pd.DataFrame(rows)

    grouped = []
    if not ch.empty:
        gcols = [
            "uf", "municipio", "zona", "old_id", "new_id", "old_name", "new_name",
            "old_address", "new_address", "old_lat", "old_lng", "new_lat", "new_lng",
        ]
        for vals, g in ch.groupby(gcols, dropna=False, sort=True):
            d = dict(zip(gcols, vals))
            for ck in ("old_lat", "old_lng", "new_lat", "new_lng"):
                if pd.isna(d.get(ck)):
                    d[ck] = None
            pairs = [
                {"first": a, "second": b}
                for a, b in sorted(
                    {(intstr(a), intstr(b)) for a, b in zip(g.s1, g.s2)},
                    key=lambda x: (int(x[0]) if x[0].isdigit() else 999999, x[0]),
                )
            ]
            d["id"] = "-".join(
                [str(d["uf"]), str(d["zona"]), str(d["old_id"] or "old"), str(d["new_id"] or "new"), str(len(grouped) + 1)]
            )
            d["section_map"] = pairs
            d["electors"] = sum(int(x) for x in g.eleitores if str(x).isdigit()) or None
            d["source"] = snapshot_meta.get("source_label") or "TSE — Dados Abertos — comparação 1º→2º turno"
            grouped.append(d)

    ufs = []
    summary = {}
    for uf, guf in loc.groupby("uf", sort=True):
        ufs.append(uf)
        locations = []
        loc_map = {}
        for vals, g in guf.groupby(
            ["uf", "municipio", "zona", "local_id", "name", "address", "bairro", "lat", "lng"],
            dropna=False,
            sort=True,
        ):
            u, m, z, l, n, a, b, lat, lng = vals
            rid = "-".join(map(str, [u, z, l]))
            secs = sorted({intstr(x) for x in g.secao}, key=lambda x: int(x) if x.isdigit() else 999999)
            lat = None if pd.isna(lat) else lat
            lng = None if pd.isna(lng) else lng
            item = {"id": rid, "u": u, "m": m, "z": z, "l": l, "n": n, "a": a, "b": b, "s": secs, "lat": lat, "lng": lng}
            locations.append(item)
            loc_map[(u, z, l)] = rid
        sections = [
            {"u": r.uf, "m": r.municipio, "z": r.zona, "s": r.secao, "location_id": loc_map.get((r.uf, r.zona, r.local_id), "")}
            for r in guf.itertuples(index=False)
        ]
        (out / "locations" / f"{uf}.json").write_text(json.dumps(locations, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        (out / "sections" / f"{uf}.json").write_text(json.dumps(sections, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")

    for c in grouped:
        s = summary.setdefault(c["uf"], {"changed_sections": 0, "change_groups": 0, "cities": set()})
        s["changed_sections"] += len(c["section_map"])
        s["change_groups"] += 1
        if c["municipio"]:
            s["cities"].add(c["municipio"])
    summary_json = [
        {"uf": uf, "changed_sections": v["changed_sections"], "change_groups": v["change_groups"], "cities": len(v["cities"])}
        for uf, v in sorted(summary.items(), key=lambda kv: (-kv[1]["changed_sections"], kv[0]))
    ]

    reported = snapshot_meta.get("reported_updated_at") or snapshot_meta.get("snapshot_at") or snapshot_meta.get("fetched_at")
    meta = {
        "demo": bool(demo),
        "election_year": 2026,
        "round_from": 1,
        "round_to": 2,
        "snapshot_at": reported,
        "snapshot_label": snapshot_meta.get("snapshot_label") or reported or "captura sem horário informado",
        "fetched_at": snapshot_meta.get("fetched_at"),
        "source_url": snapshot_meta.get("source_url"),
        "source_file": snapshot_meta.get("download_name") or snapshot_meta.get("source_file"),
        "source_sha256": snapshot_meta.get("sha256"),
        "source_kind": snapshot_meta.get("source_kind", "official-tse" if not demo else "demo"),
        "stale": bool(snapshot_meta.get("stale", False)),
        "changed_sections": sum(len(x["section_map"]) for x in grouped),
        "change_groups": len(grouped),
        "cities": len({(x["uf"], x["municipio"]) for x in grouped if x["municipio"]}),
        "ufs_with_changes": len({x["uf"] for x in grouped}),
        "ufs": ufs,
        "source": snapshot_meta.get("source_label") or "TSE — Dados Abertos — Eleitorado por local de votação",
    }
    (out / "changes.json").write_text(json.dumps(grouped, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary_json, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--changes-file", type=Path, default=Path("data-src/alteracoes-oficiais.csv"))
    ap.add_argument("--snapshot-meta", type=Path)
    ap.add_argument("--locations-file", type=Path)
    ap.add_argument("--cache", type=Path, default=Path(".cache"))
    ap.add_argument("--out", type=Path, default=Path("site/data"))
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()

    if not args.changes_file.exists():
        raise SystemExit(f"Falta {args.changes_file}. O build público exige o snapshot oficial atual do TSE.")

    locations_path = args.locations_file or (args.cache / "eleitorado_local_votacao_2026.zip")
    if not args.locations_file:
        download(discover_locations_url(), locations_path)

    snapshot_meta = load_snapshot_meta(args.snapshot_meta, args.changes_file)
    env_snapshot = os.getenv("TSE_SNAPSHOT_AT")
    if env_snapshot:
        snapshot_meta["reported_updated_at"] = env_snapshot

    build(read_changes(args.changes_file), read_locations(locations_path), args.out, snapshot_meta, demo=args.demo)


if __name__ == "__main__":
    main()
