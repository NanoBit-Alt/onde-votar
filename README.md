# Onde voto agora? — 2º turno 2026 · v4

Mapa interativo para responder à pergunta prática:

> **Votei nesta zona/seção no 1º turno. Onde devo votar no 2º turno?**

A aplicação continua permitindo explorar todas as seções, mas o destaque principal são as mudanças de local entre os turnos.

## O que mudou na v4

A v3 tentava automatizar a exportação do painel **SIG/Capilaridade** do TSE usando Chromium/Playwright. Esse painel é uma aplicação Oracle APEX e pode responder `403`/WAF para runners de nuvem, como GitHub Actions. Quando isso acontecia e ainda não havia um snapshot versionado, o workflow parava com:

```text
Falha ao exportar o TSE e não há snapshot oficial versionado para fallback.
```

A v4 remove essa dependência do painel para o build principal.

Agora o GitHub Action usa apenas arquivos públicos oficiais do **CDN/Dados Abertos do TSE**:

- `eleitorado_local_votacao_2026.zip` — cadastro de locais/seções;
- `detalhe_votacao_secao_2026.zip` — baseline do 1º turno quando o cadastro atual não traz os dois turnos separadamente.

O script `scripts/derive_tse_changes.py` compara os registros pela chave:

```text
UF + código do município + zona + seção
```

Se o arquivo atual trouxer `NR_TURNO=1` e `NR_TURNO=2`, a comparação é feita dentro do próprio arquivo. Caso contrário, o script usa o detalhe da apuração do 1º turno como baseline.

São detectadas, entre outras situações:

- mudança do `NR_LOCAL_VOTACAO`;
- mudança material de endereço mantendo o mesmo código de local;
- mudança relevante de coordenadas/nome/endereço.

O CSV derivado é salvo como artefato do workflow junto com metadados e SHA-256, para auditoria.

## Importante sobre o total de mudanças

O TSE e os TREs estão atualizando os cadastros até perto do 2º turno. Os números divulgados podem mudar bastante entre snapshots e diferentes publicações oficiais podem estar em sincronização em horários distintos.

Por isso o site:

- mostra a data do snapshot usado;
- não fixa o número “4.352” no código;
- usa o cadastro aberto vigente no momento do workflow;
- orienta o eleitor a confirmar individualmente no **e-Título** ou **Autoatendimento Eleitoral**.

## Como publicar

1. substitua os arquivos da versão anterior pelos desta v4;
2. faça commit e push para `main`;
3. em **Settings → Pages**, mantenha **Source = GitHub Actions**;
4. abra **Actions → Atualizar TSE e publicar GitHub Pages**;
5. clique em **Run workflow**.

No PowerShell, dentro da pasta do projeto:

```powershell
git add -A
git commit -m "v4: usar dados abertos do TSE sem depender do SIG"
git push
```

## O que o workflow faz

```text
Dados Abertos TSE
   ↓
eleitorado_local_votacao_2026.zip
   ↓
identifica 1º e 2º turnos
   ├─ se ambos existirem: compara diretamente
   └─ senão: usa detalhe_votacao_secao_2026.zip como baseline do 1º turno
   ↓
deriva seções com mudança de local
   ↓
gera site/data/*.json
   ↓
valida
   ↓
publica no GitHub Pages
```

Cada execução também guarda por 14 dias um artefato chamado aproximadamente:

```text
snapshot-tse-123
```

contendo:

```text
alteracoes-oficiais.csv
alteracoes-oficiais.meta.json
```

Isso permite conferir exatamente qual snapshot gerou a versão publicada.

## Estrutura

```text
.github/workflows/deploy-pages.yml
scripts/
  derive_tse_changes.py
  build_data.py
  validate_data.py
site/
  index.html
  assets/
  data/
fixtures/
data-src/
```

## Busca

A busca principal pede:

- seção em que a pessoa votou no 1º turno;
- UF;
- município opcional;
- zona opcional.

Zona e município são úteis porque o número de uma seção pode se repetir em lugares diferentes.

O site não precisa de CPF, nome, número do título, data de nascimento ou filiação.

## Fonte individual final

Mesmo que a seção não apareça como alterada no mapa, o eleitor deve confirmar o endereço no e-Título ou no Autoatendimento Eleitoral antes de sair para votar. O mapa é uma ferramenta de consulta e visualização de dados públicos, não substitui o serviço individual da Justiça Eleitoral.

## Mapa-base na v6.1

A v6.1 não usa CARTO e não precisa de `CARTO_BASEMAP_KEY`. O mapa utiliza camadas públicas de imagem e referência carregadas diretamente pelo MapLibre.

Se você já criou o secret `CARTO_BASEMAP_KEY` no GitHub, pode deixá-lo cadastrado ou removê-lo: ele não é mais lido pelo workflow.

O workflow também valida que nenhuma referência antiga a `cartocdn.com` ou ao placeholder `__CARTO_BASEMAP_KEY__` tenha voltado ao frontend antes de publicar.
