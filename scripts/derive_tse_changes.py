#!/usr/bin/env python3
"""Deriva mudanças de local entre 1º e 2º turnos usando somente arquivos abertos oficiais do TSE.

Por que existe:
- o painel SIG/Oracle APEX do TSE pode bloquear runners de datacenter (403/WAF);
- os arquivos do CDN de Dados Abertos são próprios para automação;
- o objetivo é responder: "votei nesta zona/seção no 1º turno; onde voto no 2º?".

Estratégia:
1. baixa o cadastro atual de locais de votação de 2026;
2. se o próprio cadastro tiver linhas NR_TURNO=1 e NR_TURNO=2, compara essas linhas;
3. caso contrário, usa "Detalhe da apuração por seção" do 1º turno como baseline e
   compara com o cadastro atual;
4. gera um CSV de mudanças e metadados auditáveis (URL + SHA-256).

O resultado é uma DERIVAÇÃO de duas bases oficiais, não uma cópia do relatório do SIG.
Em caso de divergência, e-Título/Autoatendimento Eleitoral permanecem a fonte individual final.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import shutil
import unicodedata
import zipfile
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

import pandas as pd
import requests

LOC_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/eleitorado_locais_votacao/eleitorado_local_votacao_2026.zip"
DETAIL_URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2026.zip"
UA = "OndeVotoAgora/4.0 (+GitHub Pages; dados publicos TSE)"

ALIASES = {
    "round": ["NR_TURNO", "TURNO"],
    "gen_date": ["DT_GERACAO", "DATA_GERACAO"],
    "gen_time": ["HH_GERACAO", "HORA_GERACAO"],
    "uf": ["SG_UF", "UF"],
    "mun_code": ["CD_MUNICIPIO", "CODIGO_MUNICIPIO", "COD_MUNICIPIO"],
    "municipio": ["NM_MUNICIPIO", "MUNICIPIO", "NOME_MUNICIPIO"],
    "zona": ["NR_ZONA", "ZONA", "ZONA_ELEITORAL", "NR_ZONA_ELEITORAL"],
    "secao": ["NR_SECAO", "SECAO", "SECAO_ELEITORAL", "NR_SECAO_ELEITORAL"],
    "local_id": ["NR_LOCAL_VOTACAO", "LOCAL_VOTACAO", "COD_LOCAL_VOTACAO", "CD_LOCAL_VOTACAO"],
    "name": ["NM_LOCAL_VOTACAO", "NOME_LOCAL_VOTACAO", "LOCAL_DE_VOTACAO"],
    "address": ["DS_ENDERECO", "DS_LOCAL_VOTACAO_ENDERECO", "ENDERECO", "ENDERECO_LOCAL_VOTACAO"],
    "lat": ["NR_LATITUDE", "LATITUDE"],
    "lng": ["NR_LONGITUDE", "LONGITUDE"],
    "electors": ["QT_ELEITORES", "QT_ELEITORADO", "QT_APTOS"],
    "office": ["CD_CARGO"],
}


def norm_label(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^A-Z0-9]+", "_", s.upper()).strip("_")


def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.upper()
    repl = {
        "AVENIDA": "AV", "RUA": "R", "RODOVIA": "ROD", "PRACA": "PC",
        "NUMERO": "", "Nº": "", "NO": "", "S/N": "SN",
    }
    for a, b in repl.items():
        s = re.sub(rf"\b{re.escape(a)}\b", b, s)
    return " ".join(re.findall(r"[A-Z0-9]+", s))


def intstr(v) -> str:
    if v is None or pd.isna(v):
        return ""
    s = str(v).strip()
    try:
        return str(int(float(s.replace(",", "."))))
    except Exception:
        return re.sub(r"\D", "", s) or s


def num(v):
    if v is None or pd.isna(v):
        return None
    try:
        return float(str(v).strip().replace(",", "."))
    except Exception:
        return None


def choose(cols: Iterable[str], aliases: list[str]):
    cmap = {norm_label(c): c for c in cols}
    for a in aliases:
        if norm_label(a) in cmap:
            return cmap[norm_label(a)]
    return None


def sniff_csv(raw: bytes):
    sample = raw[:20000]
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = sample.decode(enc)
        except Exception:
            continue
        try:
            dialect = csv.Sniffer().sniff(text, delimiters=";,\t,")
            return enc, dialect.delimiter
        except Exception:
            # Arquivos do TSE normalmente são latin-1/;.
            if ";" in text:
                return enc, ";"
    return "latin-1", ";"


def zip_csv_members(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist() if n.lower().endswith(".csv") and not n.startswith("__MACOSX")]


def read_member(path: Path, member: str, usecols=None, chunksize=None):
    with zipfile.ZipFile(path) as z:
        head = z.read(member)[:20000]
        enc, sep = sniff_csv(head)
        with z.open(member) as f:
            return pd.read_csv(f, sep=sep, encoding=enc, dtype=str, usecols=usecols, low_memory=False, chunksize=chunksize)


def header(path: Path, member: str) -> list[str]:
    with zipfile.ZipFile(path) as z:
        head = z.read(member)[:20000]
        enc, sep = sniff_csv(head)
        with z.open(member) as f:
            return list(pd.read_csv(f, sep=sep, encoding=enc, dtype=str, nrows=0).columns)


def download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1000:
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, headers={"User-Agent": UA}, stream=True, timeout=(30, 240)) as r:
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)
    tmp.replace(dest)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def select_columns(cols):
    return {k: choose(cols, v) for k, v in ALIASES.items()}


def normalize_frame(df: pd.DataFrame, sel: dict) -> pd.DataFrame:
    out = pd.DataFrame()
    for k in ("round", "gen_date", "gen_time", "uf", "mun_code", "municipio", "zona", "secao", "local_id", "name", "address", "lat", "lng", "electors", "office"):
        c = sel.get(k)
        out[k] = df[c] if c and c in df else ""
    for c in ("round", "mun_code", "zona", "secao", "local_id", "electors", "office"):
        out[c] = out[c].map(intstr)
    for c in ("gen_date", "gen_time", "uf", "municipio", "name", "address"):
        out[c] = out[c].fillna("").astype(str).str.strip()
    out["uf"] = out["uf"].str.upper()
    out["lat"] = out["lat"].map(num)
    out["lng"] = out["lng"].map(num)
    return out


def load_locations_zip(path: Path) -> pd.DataFrame:
    members = zip_csv_members(path)
    if not members:
        raise RuntimeError("ZIP de locais sem CSV")
    frames = []
    for m in members:
        cols = header(path, m)
        sel = select_columns(cols)
        required = ["uf", "municipio", "zona", "secao", "local_id", "name"]
        if any(not sel.get(k) for k in required):
            continue
        use = sorted({c for c in sel.values() if c})
        df = read_member(path, m, usecols=use)
        frames.append(normalize_frame(df, sel))
    if not frames:
        raise RuntimeError("Não encontrei CSV de locais com as colunas esperadas")
    out = pd.concat(frames, ignore_index=True)
    out = out[(out.uf != "") & (out.uf != "ZZ") & (out.zona != "") & (out.secao != "")]
    return out


def load_first_round_detail(path: Path) -> pd.DataFrame:
    members = zip_csv_members(path)
    if not members:
        raise RuntimeError("ZIP de detalhe sem CSV")
    brasil = [m for m in members if "BRASIL" in m.upper() or "_BR." in m.upper()]
    targets = brasil if brasil else members
    frames = []
    for m in targets:
        cols = header(path, m)
        sel = select_columns(cols)
        required = ["uf", "municipio", "zona", "secao", "local_id", "name"]
        if any(not sel.get(k) for k in required):
            continue
        use = sorted({c for c in sel.values() if c})
        df = read_member(path, m, usecols=use)
        n = normalize_frame(df, sel)
        if sel.get("round"):
            n = n[n["round"] == "1"]
        if sel.get("office"):
            # Presidente; serve apenas para eliminar repetições por cargo.
            n = n[(n["office"] == "1") | (n["office"] == "")]
        frames.append(n)
    if not frames:
        raise RuntimeError("Não encontrei dados do 1º turno no detalhe por seção")
    out = pd.concat(frames, ignore_index=True)
    out = out[(out.uf != "") & (out.uf != "ZZ") & (out.zona != "") & (out.secao != "")]
    return out.drop_duplicates(["uf", "mun_code", "zona", "secao"], keep="last")


def dedupe_round(df: pd.DataFrame) -> pd.DataFrame:
    return df.drop_duplicates(["uf", "mun_code", "zona", "secao"], keep="last")


def distance_m(a_lat, a_lng, b_lat, b_lng):
    if None in (a_lat, a_lng, b_lat, b_lng):
        return None
    try:
        r = 6371000.0
        p1, p2 = math.radians(a_lat), math.radians(b_lat)
        dp = math.radians(b_lat - a_lat)
        dl = math.radians(b_lng - a_lng)
        h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * r * math.asin(math.sqrt(h))
    except Exception:
        return None


def numbers(s: str):
    return re.findall(r"\b\d+[A-Z]?\b", norm_text(s))


def materially_changed(old, new):
    oid, nid = old.local_id, new.local_id
    if oid and nid and oid != nid:
        return True, "local_id_changed"

    on, nn = norm_text(old.name), norm_text(new.name)
    oa, na = norm_text(old.address), norm_text(new.address)
    d = distance_m(old.lat, old.lng, new.lat, new.lng)
    if d is not None and d >= 120:
        return True, "coordinates_changed"

    if oa and na and oa != na:
        old_nums, new_nums = numbers(oa), numbers(na)
        ratio = SequenceMatcher(None, oa, na).ratio()
        if old_nums and new_nums and old_nums != new_nums:
            return True, "address_number_changed"
        if ratio < 0.72:
            return True, "address_changed"

    if on and nn and on != nn and oa and na:
        if SequenceMatcher(None, on, nn).ratio() < 0.58 and SequenceMatcher(None, oa, na).ratio() < 0.90:
            return True, "place_changed_same_id"

    return False, ""


def derive(first: pd.DataFrame, second: pd.DataFrame) -> pd.DataFrame:
    keys = ["uf", "mun_code", "zona", "secao"]
    first = dedupe_round(first)
    second = dedupe_round(second)
    f = {tuple(getattr(r, k) for k in keys): r for r in first.itertuples(index=False)}
    rows = []
    for n in second.itertuples(index=False):
        key = tuple(getattr(n, k) for k in keys)
        o = f.get(key)
        if not o:
            continue
        changed, kind = materially_changed(o, n)
        if not changed:
            continue
        rows.append({
            "SG_UF": n.uf,
            "CD_MUNICIPIO": n.mun_code or o.mun_code,
            "NM_MUNICIPIO": n.municipio or o.municipio,
            "NR_ZONA": n.zona,
            "NR_SECAO_1T": o.secao,
            "NR_SECAO_2T": n.secao,
            "NR_LOCAL_VOTACAO_1T": o.local_id,
            "NR_LOCAL_VOTACAO_2T": n.local_id,
            "NM_LOCAL_VOTACAO_1T": o.name,
            "DS_ENDERECO_1T": o.address,
            "NM_LOCAL_VOTACAO_2T": n.name,
            "DS_ENDERECO_2T": n.address,
            "QT_ELEITORES": n.electors or o.electors,
            "TP_MUDANCA_DERIVADA": kind,
        })
    return pd.DataFrame(rows)


def infer_generated_at(df: pd.DataFrame):
    """Tenta usar DT_GERACAO/HH_GERACAO do próprio arquivo do TSE."""
    vals = []
    if "gen_date" not in df or "gen_time" not in df:
        return None
    for d, h in zip(df["gen_date"], df["gen_time"]):
        d, h = str(d or "").strip(), str(h or "").strip()
        if not d:
            continue
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                dt = datetime.strptime(f"{d} {h or '00:00'}", fmt)
                vals.append(dt)
                break
            except ValueError:
                continue
    if not vals:
        return None
    latest = max(vals)
    return latest.strftime("%Y-%m-%dT%H:%M:%S-03:00")


def choose_rounds(current: pd.DataFrame, detail_path: Path | None):
    rounds = sorted({x for x in current["round"].unique() if x})
    if "1" in rounds and "2" in rounds:
        return current[current["round"] == "1"].copy(), current[current["round"] == "2"].copy(), "current-file-rounds"
    if detail_path is None:
        raise RuntimeError("Cadastro atual não separa turnos e baseline do 1º turno não foi informado")
    first = load_first_round_detail(detail_path)
    # Sem NR_TURNO no cadastro, ele representa o estado vigente; usamos como 2º turno.
    second = current[current["round"].isin(["2", ""])].copy()
    return first, second, "first-round-detail-vs-current-locations"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(".cache/alteracoes-oficiais.csv"))
    ap.add_argument("--meta-out", type=Path, default=Path(".cache/alteracoes-oficiais.meta.json"))
    ap.add_argument("--locations-out", type=Path, default=Path(".cache/eleitorado_local_votacao_2026.zip"))
    ap.add_argument("--detail-out", type=Path, default=Path(".cache/detalhe_votacao_secao_2026.zip"))
    ap.add_argument("--locations-file", type=Path)
    ap.add_argument("--detail-file", type=Path)
    args = ap.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.meta_out.parent.mkdir(parents=True, exist_ok=True)

    loc_path = args.locations_file or args.locations_out
    if not args.locations_file:
        download(LOC_URL, loc_path)

    current = load_locations_zip(loc_path)
    rounds = {x for x in current["round"].unique() if x}

    detail_path = args.detail_file
    if not ("1" in rounds and "2" in rounds):
        detail_path = detail_path or args.detail_out
        if not args.detail_file:
            download(DETAIL_URL, detail_path)

    first, second, method = choose_rounds(current, detail_path)
    data_generated_at = infer_generated_at(second)
    changes = derive(first, second)
    if changes.empty:
        raise SystemExit("Nenhuma mudança derivada. Para evitar publicar falso negativo, o build foi interrompido.")

    changes = changes.sort_values(["SG_UF", "NM_MUNICIPIO", "NR_ZONA", "NR_SECAO_1T"], kind="stable")
    changes.to_csv(args.out, sep=";", index=False, encoding="utf-8-sig")

    meta = {
        "source_kind": "official-tse-open-data-derived",
        "source_label": "TSE — Dados Abertos — locais de votação (comparação 1º→2º turno)",
        "source_url": LOC_URL,
        "source_file": loc_path.name,
        "download_name": loc_path.name,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "reported_updated_at": data_generated_at or datetime.now(timezone.utc).isoformat(),
        "sha256": sha256(loc_path),
        "baseline_url": None if method == "current-file-rounds" else DETAIL_URL,
        "baseline_sha256": None if method == "current-file-rounds" else sha256(detail_path),
        "derivation_method": method,
        "derived_changed_sections": int(len(changes)),
        "note": "Mudanças derivadas de bases abertas oficiais do TSE; confirmação individual deve ser feita no e-Título/Autoatendimento.",
    }
    args.meta_out.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
