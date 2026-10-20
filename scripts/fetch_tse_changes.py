#!/usr/bin/env python3
"""Exporta o relatório oficial do TSE/SIG via navegador real (Oracle APEX).

O painel é dinâmico e o link direto pode variar de sessão. Em vez de depender de um endpoint
privado/instável, este coletor navega pela interface pública e solicita a exportação CSV.

Se o TSE alterar a interface, o script salva HTML, screenshot e lista de botões em --debug-dir.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

HOME = "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/home"
CAPILARIDADE = "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/painel-capilaridade"
REPORT_TEXT = "Seções Eleitorais Alteradas no Segundo Turno"


def save_debug(page: Page, debug_dir: Path, label: str):
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        (debug_dir / f"{label}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass
    try:
        page.screenshot(path=str(debug_dir / f"{label}.png"), full_page=True)
    except Exception:
        pass
    try:
        texts = page.locator("button, a, [role=button], select, input").all_inner_texts()
        (debug_dir / f"{label}-controls.txt").write_text("\n".join(x.strip() for x in texts if x.strip()), encoding="utf-8")
    except Exception:
        pass


def first_visible(page: Page, selectors: list[str]):
    for selector in selectors:
        loc = page.locator(selector)
        try:
            if loc.count() and loc.first.is_visible():
                return loc.first
        except Exception:
            pass
    return None


def try_click(page: Page, selectors: list[str], timeout=4000):
    loc = first_visible(page, selectors)
    if not loc:
        return False
    try:
        loc.click(timeout=timeout)
        return True
    except Exception:
        return False


def choose_2026(page: Page):
    # Tentativas não destrutivas: APEX pode renderizar filtros como select, botão ou combobox.
    for sel in page.locator("select").all():
        try:
            options = sel.locator("option").all_inner_texts()
            if any("2026" in o for o in options):
                sel.select_option(label=re.compile("2026"))
        except Exception:
            continue
    for pattern in (r"Ano.*elei", r"Eleição", r"Ano"):
        try:
            combo = page.get_by_role("combobox", name=re.compile(pattern, re.I))
            if combo.count() and combo.first.is_visible():
                combo.first.select_option(label=re.compile("2026"))
        except Exception:
            pass


def navigate_report(page: Page):
    page.goto(HOME, wait_until="domcontentloaded", timeout=120000)
    page.wait_for_timeout(1500)
    choose_2026(page)

    if REPORT_TEXT.lower() not in page.locator("body").inner_text().lower():
        if not try_click(page, [
            'a:has-text("Capilaridade")',
            'button:has-text("Capilaridade")',
            '[role="menuitem"]:has-text("Capilaridade")',
            'text=Capilaridade',
        ]):
            page.goto(CAPILARIDADE, wait_until="domcontentloaded", timeout=120000)
        page.wait_for_timeout(1800)
        choose_2026(page)

    page.get_by_text(re.compile("Seções Eleitorais Alteradas no Segundo Turno", re.I)).first.wait_for(
        state="visible", timeout=60000
    )


def locate_report_region(page: Page):
    heading = page.get_by_text(re.compile("Seções Eleitorais Alteradas no Segundo Turno", re.I)).first
    candidates = [
        heading.locator("xpath=ancestor::*[contains(@class,'t-Region')][1]"),
        heading.locator("xpath=ancestor::*[contains(@class,'a-IRR')][1]"),
        heading.locator("xpath=ancestor::section[1]"),
        heading.locator("xpath=ancestor::div[1]"),
    ]
    for c in candidates:
        try:
            if c.count():
                return c.first
        except Exception:
            pass
    return page.locator("body")


def trigger_download(page: Page, context: BrowserContext, out: Path):
    region = locate_report_region(page)

    direct_selectors = [
        'a[download][href*="csv" i]',
        'a:has-text("CSV")',
        'button:has-text("CSV")',
        '[title*="Baixar" i]',
        '[aria-label*="Baixar" i]',
        '[title*="Download" i]',
        '[aria-label*="Download" i]',
    ]
    for selector in direct_selectors:
        target = region.locator(selector)
        try:
            if target.count() and target.first.is_visible():
                with page.expect_download(timeout=12000) as info:
                    target.first.click()
                dl = info.value
                dl.save_as(str(out))
                return dl.suggested_filename
        except Exception:
            pass

    # Caminho padrão de Interactive Report do Oracle APEX: Ações -> Baixar -> CSV.
    actions = first_visible(page, [
        '.a-IRR-button--actions',
        'button[aria-label*="Ações" i]',
        'button[title*="Ações" i]',
        'button:has-text("Ações")',
        'button[aria-label*="Actions" i]',
        'button[title*="Actions" i]',
        'button:has-text("Actions")',
    ])
    if actions:
        actions.click()
        page.wait_for_timeout(500)
        if not try_click(page, [
            '[role="menuitem"]:has-text("Baixar")',
            '[role="menuitem"]:has-text("Download")',
            'button:has-text("Baixar")',
            'button:has-text("Download")',
            'a:has-text("Baixar")',
            'a:has-text("Download")',
        ], timeout=5000):
            raise RuntimeError("Menu Ações abriu, mas não encontrei a opção Baixar/Download")
        page.wait_for_timeout(700)

        # Diálogo de exportação: escolhe CSV quando houver múltiplos formatos.
        try_click(page, [
            'label:has-text("CSV")',
            '[role="radio"][aria-label*="CSV" i]',
            'input[value="CSV"]',
            'button:has-text("CSV")',
        ], timeout=3000)

        final = first_visible(page, [
            'button:has-text("Baixar")',
            'button:has-text("Download")',
            '.ui-dialog button:has-text("Baixar")',
            '.ui-dialog button:has-text("Download")',
            'a:has-text("Baixar")',
            'a:has-text("Download")',
        ])
        if final:
            with page.expect_download(timeout=30000) as info:
                final.click()
            dl = info.value
            dl.save_as(str(out))
            return dl.suggested_filename

    # Último recurso: procura qualquer controle CSV/Download global depois da navegação.
    target = first_visible(page, direct_selectors + ['text=CSV'])
    if target:
        with page.expect_download(timeout=30000) as info:
            target.click()
        dl = info.value
        dl.save_as(str(out))
        return dl.suggested_filename

    raise RuntimeError("Não foi possível iniciar a exportação CSV do relatório")


def extract_reported_updated_at(text: str):
    patterns = [
        r"(?:Atualizado|Atualização|Dados atualizados)(?:\s+em)?\s*[:\-]?\s*(\d{1,2}/\d{1,2}/\d{4})\s*(?:às|as|\s)\s*(\d{1,2}:\d{2})",
        r"(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})",
    ]
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            d, h = m.group(1), m.group(2)
            day, month, year = map(int, d.split("/"))
            return f"{year:04d}-{month:02d}-{day:02d}T{h}:00-03:00"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(".cache/alteracoes-oficiais.csv"))
    ap.add_argument("--meta-out", type=Path, default=Path(".cache/alteracoes-oficiais.meta.json"))
    ap.add_argument("--debug-dir", type=Path, default=Path(".debug-tse"))
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.meta_out.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context(
            locale="pt-BR",
            timezone_id="America/Sao_Paulo",
            accept_downloads=True,
            viewport={"width": 1440, "height": 1100},
        )
        page = context.new_page()
        try:
            navigate_report(page)
            body = page.locator("body").inner_text()
            save_debug(page, args.debug_dir, "report-ready")
            suggested = trigger_download(page, context, args.out)
            if not args.out.exists() or args.out.stat().st_size < 100:
                raise RuntimeError("Arquivo exportado está vazio ou pequeno demais")
            sha = hashlib.sha256(args.out.read_bytes()).hexdigest()
            meta = {
                "source_kind": "official-tse",
                "source_url": CAPILARIDADE,
                "download_name": suggested,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "reported_updated_at": extract_reported_updated_at(body),
                "sha256": sha,
            }
            args.meta_out.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(meta, ensure_ascii=False, indent=2))
        except Exception:
            save_debug(page, args.debug_dir, "failure")
            raise
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
