# Onde voto agora? — alterações do 1º para o 2º turno de 2026

Mapa interativo estático para GitHub Pages com uma pergunta principal:

> **Em qual local eu devo votar no 2º turno, usando como referência a seção em que votei no 1º turno?**

O projeto não tenta descobrir a mudança comparando 2024 com 2026. A fonte prioritária é o relatório da Justiça Eleitoral **“Seções Eleitorais Alteradas no Segundo Turno”**, no painel de Capilaridade do TSE.

## Fluxo para o eleitor

1. informe **seção do 1º turno + UF**;
2. município e zona são opcionais e servem para desempatar números repetidos;
3. a aplicação procura primeiro no snapshot das alterações entre os turnos;
4. se encontrar, mostra **seção 1º turno → seção 2º turno**, **local anterior → novo local** e faz zoom no novo endereço;
5. se não encontrar, consulta a base nacional de locais de votação de 2026 da UF e mostra o local cadastrado, sem afirmar que ele “não mudou” — o usuário é orientado a confirmar no TSE.

A modelagem aceita renumeração de seção (`seção_1t != seção_2t`). Isso é necessário em redistribuições eleitorais, não apenas em mudanças de prédio.

## O mapa

- abre no Brasil mostrando somente os locais afetados pelo snapshot atual;
- usa agrupamento de pontos para não sobrecarregar o mapa;
- pontos alterados têm pulso visual;
- clicar ou pesquisar um local executa zoom suave (`flyTo`);
- quando existem coordenadas do local antigo e do novo, desenha o deslocamento **antes → agora**;
- a camada **Todas as seções** é secundária e é carregada por UF, sob demanda;
- a busca livre aceita município, escola, endereço, zona ou seção.

## Atualização automática do TSE

O painel do TSE é uma aplicação Oracle APEX dinâmica. A v3 inclui `scripts/fetch_tse_changes.py`, que usa Chromium/Playwright para navegar pela interface pública e solicitar a exportação do relatório, em vez de depender de uma URL de sessão instável.

O workflow `.github/workflows/deploy-pages.yml` tenta atualizar o snapshot três vezes por dia. Em cada execução:

1. abre o painel do TSE com Chromium;
2. tenta exportar “Seções Eleitorais Alteradas no Segundo Turno”;
3. baixa/usa o cadastro nacional `Eleitorado por local de votação - 2026`;
4. cruza a alteração com nome, endereço e coordenadas;
5. valida o resultado;
6. publica o site no GitHub Pages.

Se a interface do TSE mudar, o coletor grava HTML, screenshot e lista dos controles em um artefato de diagnóstico do GitHub Actions.

## Proteção contra publicação incorreta

O build de produção **não publica a amostra de desenvolvimento** e também rejeita snapshots suspeitos com pouquíssimas seções.

Se a coleta automática falhar:

- havendo um snapshot oficial previamente versionado em `data-src/`, ele é usado e o site mostra explicitamente que está desatualizado;
- sem fallback oficial, o workflow falha e **não substitui o site por dados falsos ou vazios**.

Isso é intencional: é melhor manter a última captura identificada do que publicar uma consulta eleitoral enganosa.

## Estrutura dos dados públicos gerados

```text
site/data/
├── meta.json                 # data/fonte/hash/estado do snapshot
├── changes.json              # mudanças agrupadas por origem → destino
├── summary.json              # totais por UF
├── sections/
│   ├── AC.json
│   ├── ...
│   └── SP.json               # índice seção → local, por UF
└── locations/
    ├── AC.json
    ├── ...
    └── SP.json               # locais, seções e coordenadas, por UF
```

Os shards por UF evitam enviar centenas de milhares de seções para todo visitante logo na abertura da página.

## Rodar a prévia local

A pasta `fixtures/` contém somente dados fictícios/de demonstração para testar a aplicação sem depender da rede.

```bash
pip install -r requirements.txt
python scripts/build_data.py \
  --changes-file fixtures/alteracoes.csv \
  --snapshot-meta fixtures/demo-meta.json \
  --locations-file fixtures/locais-2026.csv \
  --out site/data \
  --demo
python scripts/validate_data.py site/data --allow-demo
cd site
python -m http.server 8080
```

Abra `http://localhost:8080`.

## Publicar no GitHub Pages

1. crie um repositório e envie o conteúdo deste ZIP;
2. em **Settings → Pages**, selecione **GitHub Actions**;
3. abra **Actions → Atualizar TSE e publicar GitHub Pages**;
4. execute `Run workflow`;
5. se a coleta do TSE funcionar, o próprio workflow monta a base nacional e publica.

Como fallback manual, veja `data-src/README.md`.

## Segurança e privacidade

A aplicação não precisa de CPF, número do título, data de nascimento ou filiação. A busca local usa apenas UF, município, zona, seção, nome do local e endereço. A confirmação definitiva deve ser feita no **e-Título** ou no **Autoatendimento Eleitoral do TSE**.

## Arquivos principais

- `site/index.html` — interface;
- `site/assets/app.js` — mapa, busca e consulta;
- `site/assets/search-worker.js` — índice de busca no navegador;
- `scripts/fetch_tse_changes.py` — coletor do painel TSE;
- `scripts/build_data.py` — normalização e geração dos shards;
- `scripts/validate_data.py` — trava de qualidade para publicação;
- `.github/workflows/deploy-pages.yml` — atualização + GitHub Pages.
