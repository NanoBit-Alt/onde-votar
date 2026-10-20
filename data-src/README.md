# Fonte das alterações 1º → 2º turno de 2026

Este projeto **não** detecta as mudanças comparando eleições de anos diferentes.

A fonte primária é a lista pública da Justiça Eleitoral em:

**Estatísticas eleitorais → Eleitorado da eleição → Capilaridade → “Seções Eleitorais Alteradas no Segundo Turno”**.

Na v3, o GitHub Actions tenta exportar esse relatório automaticamente com um navegador Chromium real, porque o painel do TSE é uma aplicação Oracle APEX dinâmica e o link de sessão não é estável.

## Snapshot manual de segurança

Se quiser impedir que uma indisponibilidade temporária do SIG interrompa a publicação, exporte manualmente o relatório oficial e salve:

- `data-src/alteracoes-oficiais.csv`
- `data-src/alteracoes-oficiais.meta.json`

Exemplo do `.meta.json`:

```json
{
  "source_kind": "official-tse",
  "source_url": "https://sig.tse.jus.br/ords/dwapr/r/seai/sig-eleicao-eleitorado/painel-capilaridade",
  "reported_updated_at": "2026-10-17T18:50:00-03:00",
  "fetched_at": "2026-10-17T21:55:00Z",
  "download_name": "secoes_alteradas.csv",
  "sha256": "..."
}
```

O site exibe a data do snapshot e marca explicitamente quando precisou publicar um fallback antigo.

## Formato aceito

O importador aceita nomes técnicos e também os rótulos humanos mais comuns do relatório. O formato normalizado recomendado é:

```csv
SG_UF;NM_MUNICIPIO;NR_ZONA;NR_SECAO_1T;NR_SECAO_2T;NR_LOCAL_VOTACAO_1T;NR_LOCAL_VOTACAO_2T;NM_LOCAL_VOTACAO_1T;DS_ENDERECO_1T;NM_LOCAL_VOTACAO_2T;DS_ENDERECO_2T;QT_ELEITORES
SP;SAO PAULO;1;50;50;1010;2020;FMU - PREDIO 10;;UNINOVE;RUA VERGUEIRO, 235;387
```

`NR_SECAO_2T` pode ser diferente de `NR_SECAO_1T`. A busca do site sempre parte da seção usada no **1º turno** e mostra a seção do 2º turno quando houver renumeração.

O cadastro `Eleitorado por local de votação - 2026`, do Portal de Dados Abertos do TSE, é usado somente para enriquecer nomes, endereços e coordenadas e para a camada secundária “Todas as seções”.
