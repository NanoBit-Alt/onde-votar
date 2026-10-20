const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const norm = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
const digits = (v) => String(v ?? '').replace(/\D/g,'').replace(/^0+(?=\d)/,'');
const safe = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = (n) => new Intl.NumberFormat('pt-BR').format(Number(n || 0));

const BR_CENTER = [-52.2, -14.5];
const BR_BOUNDS = [[-75.3, -34.8], [-28.4, 6.8]];

function buildMapStyle(){
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community'
      },
      light: {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles © Esri'
      },
      labels: {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Labels © Esri'
      }
    },
    layers: [
      { id: 'satellite-base', type: 'raster', source: 'satellite', layout: { visibility: 'visible' }, paint: {'raster-opacity': 1} },
      { id: 'light-base', type: 'raster', source: 'light', layout: { visibility: 'none' }, paint: {'raster-opacity': 1} },
      { id: 'labels-overlay', type: 'raster', source: 'labels', layout: { visibility: 'visible' }, paint: {'raster-opacity': 0.92} }
    ]
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: buildMapStyle(),
  center: BR_CENTER,
  zoom: 3.55,
  minZoom: 3.1,
  maxZoom: 18,
  maxBounds: BR_BOUNDS,
  renderWorldCopies: false,
  attributionControl: true
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

let meta = {};
let changes = [];
let summary = [];
let tableRows = [];
let mode = 'changes';
let selectedUf = '';
let loadedUf = '';
let ufSections = [];
let ufLocations = [];
let changePointRows = [];
let locationPointRows = [];
let selectedChange = null;
let selectedPair = null;
let pulseRaf = null;

const worker = new Worker('./assets/search-worker.js');
worker.onmessage = ({ data }) => {
  if(data.type === 'results') renderSearch(data.results || []);
};

async function loadJson(path){
  const response = await fetch(path, { cache: 'no-store' });
  if(!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function validCoord(lat, lng){
  return Number.isFinite(+lat) && Number.isFinite(+lng) && Math.abs(+lat) <= 90 && Math.abs(+lng) <= 180;
}

function parseDateLabel(v){
  if(!v) return '—';
  const date = new Date(v);
  return Number.isNaN(date.valueOf()) ? v : date.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function allSectionPairs(change){
  if(Array.isArray(change.section_map) && change.section_map.length){
    return change.section_map.map(item => ({ first: digits(item.first), second: digits(item.second || item.first) }));
  }
  return (change.sections || []).map(section => ({ first: digits(section), second: digits(section) }));
}

function changeSectionsFirst(change){
  return allSectionPairs(change).map(item => item.first).filter(Boolean);
}

function changeSearchRow(change){
  const sections = changeSectionsFirst(change);
  return {
    id: change.id,
    kind: 'change',
    u: change.uf,
    m: change.municipio,
    z: String(change.zona),
    n: change.new_name || change.old_name || 'Local alterado',
    a: change.new_address || '',
    s: sections,
    c: true,
    lat: change.new_lat,
    lng: change.new_lng,
    q: norm(`${change.municipio} ${change.uf} ${change.zona} ${sections.join(' ')} ${change.old_name || ''} ${change.new_name || ''} ${change.old_address || ''} ${change.new_address || ''}`)
  };
}

function locationSearchRow(location){
  return {
    id: location.id,
    kind: 'location',
    u: location.u,
    m: location.m,
    z: String(location.z),
    n: location.n,
    a: location.a || '',
    s: location.s || [],
    c: false,
    lat: location.lat,
    lng: location.lng,
    q: norm(`${location.m} ${location.u} ${location.z} ${(location.s || []).join(' ')} ${location.n || ''} ${location.a || ''} ${location.b || ''}`)
  };
}

function createPinImage(fill, stroke = '#ffffff'){
  const ratio = 2;
  const width = 30 * ratio;
  const height = 42 * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(15, 41);
  ctx.bezierCurveTo(15, 41, 4.5, 25.5, 4.5, 17);
  ctx.arc(15, 15, 10.5, Math.PI, 0, false);
  ctx.bezierCurveTo(25.5, 25.5, 15, 41, 15, 41);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.8;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(15, 15, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.fill();

  return ctx.getImageData(0, 0, width, height);
}

function ensureMapImages(){
  if(!map.hasImage('change-pin')) map.addImage('change-pin', createPinImage('#ffb020'));
  if(!map.hasImage('location-pin')) map.addImage('location-pin', createPinImage('#0a7cff'));
  if(!map.hasImage('selected-old-pin')) map.addImage('selected-old-pin', createPinImage('#6f86a0'));
  if(!map.hasImage('selected-new-pin')) map.addImage('selected-new-pin', createPinImage('#0ca678'));
}

function updateBaseMap(){
  if(!map.getLayer('satellite-base') || !map.getLayer('light-base') || !map.getLayer('labels-overlay')) return;
  const selected = document.querySelector('.base-btn.active')?.dataset.base || 'satellite';
  const labelsVisible = $('#toggleLabels').checked ? 'visible' : 'none';
  map.setLayoutProperty('satellite-base', 'visibility', selected === 'satellite' ? 'visible' : 'none');
  map.setLayoutProperty('light-base', 'visibility', selected === 'topo' ? 'visible' : 'none');
  map.setLayoutProperty('labels-overlay', 'visibility', labelsVisible);
}

function updateSourceStatus(){
  const el = $('#sourceStatus');
  if(!el) return;
  const label = parseDateLabel(meta.snapshot_at);
  const src = meta.source_kind === 'official-tse-open-data-derived' ? 'dados abertos do TSE' : 'snapshot carregado';
  el.innerHTML = `<span class="live-dot ${meta.stale ? 'stale' : ''}"></span><strong>${meta.stale ? 'último snapshot disponível' : src}</strong> ${safe(label)}`;
}

function scopedChanges(){
  return selectedUf ? changes.filter(change => change.uf === selectedUf) : changes;
}

function updateStats(){
  const rows = scopedChanges();
  $('#statSections').textContent = fmt(rows.reduce((sum, change) => sum + changeSectionsFirst(change).length, 0));
  $('#statGroups').textContent = fmt(rows.length);
  $('#statCities').textContent = fmt(new Set(rows.filter(change => change.municipio).map(change => `${change.uf}|${change.municipio}`)).size);
  $('#statUpdated').textContent = parseDateLabel(meta.snapshot_at).split(',')[0];
}

function buildTableRows(){
  tableRows = changes.flatMap(change => allSectionPairs(change).map(pair => ({
    change,
    uf: change.uf,
    municipio: change.municipio,
    zona: String(change.zona),
    first: pair.first,
    second: pair.second || pair.first,
    oldName: change.old_name || '',
    newName: change.new_name || '',
    oldAddress: change.old_address || '',
    newAddress: change.new_address || '',
    q: norm(`${change.uf} ${change.municipio} ${change.zona} ${pair.first} ${pair.second || pair.first} ${change.old_name || ''} ${change.new_name || ''} ${change.new_address || ''} ${change.old_address || ''}`)
  })));
}

function updateTableMeta(filteredRows){
  const rows = filteredRows || tableRows;
  const sections = rows.length;
  const groups = new Set(rows.map(row => row.change.id)).size;
  const cities = new Set(rows.map(row => `${row.uf}|${row.municipio}`)).size;
  const ufs = new Set(rows.map(row => row.uf)).size;
  $('#tableKpis').innerHTML = [
    {label:'seções filtradas', value: fmt(sections)},
    {label:'locais / grupos', value: fmt(groups)},
    {label:'municípios', value: fmt(cities)},
    {label:'UFs', value: fmt(ufs)}
  ].map(card => `<div class="stat-card"><strong>${card.value}</strong><span>${card.label}</span></div>`).join('');
  $('#tableSummaryText').textContent = `Exibindo ${fmt(sections)} seções alteradas${rows.length !== tableRows.length ? ` de um total de ${fmt(tableRows.length)}` : ''}. Clique em “Ver no mapa” para destacar o novo local e manter a confirmação oficial do TSE ao alcance.`;
}

function renderTable(){
  const query = norm($('#tableSearch').value || '');
  const uf = $('#tableUfFilter').value || '';
  const rows = tableRows.filter(row => (!uf || row.uf === uf) && (!query || row.q.includes(query)));
  updateTableMeta(rows);
  $('#tableBody').innerHTML = rows.length ? rows.map((row, index) => `
    <tr>
      <td class="mono">${safe(row.uf)}</td>
      <td>${safe(row.municipio)}</td>
      <td class="mono">${safe(row.zona)}</td>
      <td class="mono">${safe(row.first)}</td>
      <td class="mono">${safe(row.second)}</td>
      <td class="truncate" title="${safe(row.oldName)}">${safe(row.oldName || '—')}</td>
      <td class="truncate" title="${safe(row.newName)}">${safe(row.newName || '—')}</td>
      <td class="truncate" title="${safe(row.newAddress)}">${safe(row.newAddress || '—')}</td>
      <td><button type="button" class="table-action-btn" data-row-index="${index}" data-original-index="${tableRows.indexOf(row)}">Ver no mapa</button></td>
    </tr>
  `).join('') : `<tr><td colspan="9">Nenhum resultado para os filtros informados.</td></tr>`;

  $('#tableBody').querySelectorAll('[data-original-index]').forEach(button => {
    button.addEventListener('click', () => {
      const row = tableRows[Number(button.dataset.originalIndex)];
      if(!row) return;
      closeOverlay('#tablePanel');
      selectedUf = row.uf;
      $('#lookupUf').value = row.uf;
      $('#ufFilter').value = row.uf;
      updateStats();
      setMode('changes');
      renderMode();
      selectChange(row.change, { first: row.first, second: row.second });
    });
  });
}

function populateUfSelectors(ufs){
  const options = ufs.map(uf => `<option value="${safe(uf)}">${safe(uf)}</option>`).join('');
  [$('#lookupUf'), $('#ufFilter'), $('#tableUfFilter')].forEach(select => select.insertAdjacentHTML('beforeend', options));
}

function showOverlay(selector){
  $(selector).classList.remove('hidden');
}

function closeOverlay(selector){
  $(selector).classList.add('hidden');
}

function removeLayer(id){ if(map.getLayer(id)) map.removeLayer(id); }
function removeSource(id){ if(map.getSource(id)) map.removeSource(id); }

function clearMapLayers(){
  [
    'cluster-count','clusters','change-pulse','change-points',
    'location-cluster-count','location-clusters','location-points',
    'selected-line','selected-points'
  ].forEach(removeLayer);
  ['changes-src','locations-src','selected-line-src','selected-points-src'].forEach(removeSource);
  changePointRows = [];
  locationPointRows = [];
}

function fitRows(rows){
  const pts = rows.filter(row => validCoord(row.new_lat ?? row.lat, row.new_lng ?? row.lng));
  if(!pts.length) return;
  const bounds = new maplibregl.LngLatBounds();
  pts.forEach(row => bounds.extend([+(row.new_lng ?? row.lng), +(row.new_lat ?? row.lat)]));
  if(pts.length === 1){
    map.flyTo({ center: bounds.getCenter(), zoom: 12.5, duration: 1300, curve: 1.4 });
  } else {
    map.fitBounds(bounds, { padding: { top: 120, right: 160, bottom: 120, left: 120 }, maxZoom: 8, duration: 1200 });
  }
}

function addClusteredSource(sourceId, rows, kind){
  const features = rows.filter(row => validCoord(row.lng, row.lat)).map((row, index) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+row.lng, +row.lat] },
    properties: { idx: index }
  }));

  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
    cluster: true,
    clusterRadius: 50,
    clusterMaxZoom: 10
  });

  const prefix = kind === 'changes' ? '' : 'location-';
  const clusterColor = kind === 'changes' ? '#ffb020' : '#0a7cff';
  const textColor = kind === 'changes' ? '#5f3a00' : '#ffffff';
  const pointLayerId = kind === 'changes' ? 'change-points' : 'location-points';
  const pointIcon = kind === 'changes' ? 'change-pin' : 'location-pin';

  map.addLayer({
    id: `${prefix}clusters`,
    type: 'circle',
    source: sourceId,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': clusterColor,
      'circle-radius': ['step', ['get', 'point_count'], 18, 12, 22, 40, 28, 120, 36],
      'circle-opacity': 0.92,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addLayer({
    id: `${prefix}cluster-count`,
    type: 'symbol',
    source: sourceId,
    filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Open Sans Bold'] },
    paint: { 'text-color': textColor }
  });

  if(kind === 'changes'){
    map.addLayer({
      id: 'change-pulse',
      type: 'circle',
      source: sourceId,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(255,176,32,0)',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffb020',
        'circle-opacity': 0.35
      }
    });
  }

  map.addLayer({
    id: pointLayerId,
    type: 'symbol',
    source: sourceId,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': pointIcon,
      'icon-size': kind === 'changes' ? 0.68 : 0.56,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'bottom'
    }
  });
}

function renderChanges(){
  clearMapLayers();
  const rows = scopedChanges();
  changePointRows = rows.filter(change => validCoord(change.new_lat, change.new_lng)).map(change => ({ ref: change, lng: change.new_lng, lat: change.new_lat }));
  if(changePointRows.length) addClusteredSource('changes-src', changePointRows, 'changes');
}

async function ensureUfData(uf){
  if(!uf) return false;
  if(loadedUf === uf) return true;
  try {
    [ufSections, ufLocations] = await Promise.all([
      loadJson(`./data/sections/${uf}.json`),
      loadJson(`./data/locations/${uf}.json`)
    ]);
    loadedUf = uf;
    worker.postMessage({ type: 'setUf', payload: ufLocations.map(locationSearchRow) });
    const cities = [...new Set(ufSections.map(row => row.m).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'pt-BR'));
    $('#cityOptions').innerHTML = cities.map(city => `<option value="${safe(city)}"></option>`).join('');
    return true;
  } catch (error) {
    console.warn('UF shard indisponível', uf, error);
    ufSections = [];
    ufLocations = [];
    loadedUf = uf;
    worker.postMessage({ type: 'setUf', payload: [] });
    return false;
  }
}

async function renderAll(){
  clearMapLayers();
  if(!selectedUf){
    showMessage('Escolha uma UF para abrir a camada com todos os locais. A visualização nacional fica focada nas alterações do 2º turno.', 'warning');
    setMode('changes');
    renderChanges();
    return;
  }
  const ok = await ensureUfData(selectedUf);
  if(!ok){
    showMessage('Não foi possível carregar a base completa dessa UF agora.', 'warning');
    setMode('changes');
    renderChanges();
    return;
  }
  locationPointRows = ufLocations.filter(row => validCoord(row.lat, row.lng));
  if(locationPointRows.length) addClusteredSource('locations-src', locationPointRows, 'locations');
  fitRows(locationPointRows);
}

function setMode(value){
  mode = value;
  $$('.filter-chip').forEach(button => button.classList.toggle('active', button.dataset.mode === value));
}

function renderMode(){
  if(mode === 'all') renderAll();
  else renderChanges();
}

function fly(lat, lng, zoom = 14.5){
  if(!validCoord(lat, lng)) return;
  map.flyTo({ center: [+lng, +lat], zoom, duration: 1700, curve: 1.55, essential: true });
}

function drawSelection(change){
  removeLayer('selected-line');
  removeSource('selected-line-src');
  removeLayer('selected-points');
  removeSource('selected-points-src');

  const pointFeatures = [];
  if(validCoord(change.old_lat, change.old_lng)) pointFeatures.push({ type: 'Feature', geometry: { type:'Point', coordinates:[+change.old_lng, +change.old_lat] }, properties: { kind:'old' } });
  if(validCoord(change.new_lat, change.new_lng)) pointFeatures.push({ type: 'Feature', geometry: { type:'Point', coordinates:[+change.new_lng, +change.new_lat] }, properties: { kind:'new' } });

  if(pointFeatures.length){
    map.addSource('selected-points-src', { type:'geojson', data:{ type:'FeatureCollection', features: pointFeatures } });
    map.addLayer({
      id: 'selected-points',
      type: 'symbol',
      source: 'selected-points-src',
      layout: {
        'icon-image': ['match', ['get','kind'], 'old', 'selected-old-pin', 'selected-new-pin'],
        'icon-size': 0.72,
        'icon-anchor': 'bottom',
        'icon-allow-overlap': true
      }
    });
  }

  if($('#toggleRoute').checked && validCoord(change.old_lat, change.old_lng) && validCoord(change.new_lat, change.new_lng)){
    map.addSource('selected-line-src', {
      type:'geojson',
      data:{ type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'LineString', coordinates:[[+change.old_lng,+change.old_lat],[+change.new_lng,+change.new_lat]] } }] }
    });
    map.addLayer({
      id:'selected-line',
      type:'line',
      source:'selected-line-src',
      paint:{
        'line-color':'#0a7cff',
        'line-width':4,
        'line-opacity':.9,
        'line-dasharray':[2,1.2]
      }
    });
  }
}

function openDrawer(html){
  $('#drawerContent').innerHTML = html;
  $('#drawer').classList.add('open');
}

function mapsUrl(item){
  const query = [item.new_name || item.n || item.old_name, item.new_address || item.a || '', item.municipio || item.m || '', item.uf || item.u || ''].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function selectChange(change, pair = allSectionPairs(change)[0]){
  selectedChange = change;
  selectedPair = pair;
  fly(change.new_lat, change.new_lng, 15);
  drawSelection(change);
  const allPairs = allSectionPairs(change);
  const pairPills = allPairs.map(item => `<span>${safe(item.first)}${item.second && item.second !== item.first ? ` → ${safe(item.second)}` : ''}</span>`).join('');

  openDrawer(`
    <div class="status-badge changed">LOCAL ALTERADO</div>
    <h2>${safe(change.new_name || change.old_name || 'Local alterado')}</h2>
    <div class="meta">${safe(change.municipio)}/${safe(change.uf)} · ${safe(change.zona)}ª Zona Eleitoral</div>
    ${pair ? `
      <div class="section-change">
        <div class="section-number"><small>Seção no 1º turno</small><strong>${safe(pair.first)}</strong></div>
        <div class="arrow">→</div>
        <div class="section-number"><small>Seção no 2º turno</small><strong>${safe(pair.second || pair.first)}</strong></div>
      </div>
    ` : ''}
    <div class="route">
      <div class="route-card old">
        <label>Onde você votou no 1º turno</label>
        <strong>${safe(change.old_name || 'Local anterior')}</strong>
        <p>${safe(change.old_address || 'Endereço do local anterior não informado nesta base.')}</p>
      </div>
      <div class="route-arrow">↓</div>
      <div class="route-card new">
        <label>Onde votar no 2º turno</label>
        <strong>${safe(change.new_name || 'Confirme no TSE')}</strong>
        <p>${safe(change.new_address || 'Endereço ainda não disponível nesta base.')}</p>
      </div>
    </div>
    <p class="eyebrow" style="margin-top:18px">SEÇÕES TRANSFERIDAS NESTE GRUPO</p>
    <div class="section-pills">${pairPills}</div>
    <div class="drawer-actions">
      <a class="primary" href="${mapsUrl(change)}" target="_blank" rel="noreferrer">Abrir novo local ↗</a>
      <a href="https://www.tse.jus.br/servicos-eleitorais/autoatendimento-eleitoral#/" target="_blank" rel="noreferrer">Verificação oficial no TSE ↗</a>
    </div>
    <p class="source-note">Fonte: ${safe(change.source || 'Justiça Eleitoral')}. Atualização carregada: ${safe(parseDateLabel(meta.snapshot_at))}. Em caso de divergência, prevalece o e-Título / Autoatendimento Eleitoral do TSE.</p>
  `);

  showMessage(`A seção ${pair.first} aparece na lista de alterações. O novo local está destacado no mapa e a confirmação oficial do TSE está logo abaixo.`, 'success');
}

function selectLocation(location, section = ''){
  fly(location.lat, location.lng, 15);
  removeLayer('selected-line');
  removeSource('selected-line-src');
  removeLayer('selected-points');
  removeSource('selected-points-src');
  if(validCoord(location.lat, location.lng)){
    map.addSource('selected-points-src', {
      type:'geojson',
      data:{ type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'Point', coordinates:[+location.lng,+location.lat] }, properties:{ kind:'new' } }] }
    });
    map.addLayer({
      id:'selected-points',
      type:'symbol',
      source:'selected-points-src',
      layout:{ 'icon-image':'selected-new-pin', 'icon-size':0.72, 'icon-anchor':'bottom', 'icon-allow-overlap':true }
    });
  }

  openDrawer(`
    <div class="status-badge same">NÃO CONSTA NESTE SNAPSHOT DE MUDANÇAS</div>
    <h2>${safe(location.n)}</h2>
    <div class="meta">${safe(location.m)}/${safe(location.u)} · ${safe(location.z)}ª Zona Eleitoral</div>
    ${section ? `<div class="section-number single"><small>Seção consultada</small><strong>${safe(section)}</strong></div>` : ''}
    <div class="route-card new">
      <label>Local cadastrado para 2026</label>
      <strong>${safe(location.a || 'Endereço não informado')}</strong>
      <p>Local nº ${safe(location.l || '—')}</p>
    </div>
    <div class="drawer-actions">
      <a class="primary" href="${mapsUrl(location)}" target="_blank" rel="noreferrer">Abrir local ↗</a>
      <a href="https://www.tse.jus.br/servicos-eleitorais/autoatendimento-eleitoral#/" target="_blank" rel="noreferrer">Verificação oficial no TSE ↗</a>
    </div>
    <p class="source-note">Não aparecer na lista de alterações significa apenas que esta combinação não consta no snapshot carregado. Antes de sair, confirme também pelo TSE.</p>
  `);
}

function showMessage(text, type = ''){
  const el = $('#lookupMessage');
  el.textContent = text;
  el.className = `lookup-message ${type}`;
  el.classList.remove('hidden');
}

function findChanged(uf, zone, section, city){
  const z = digits(zone);
  const s = digits(section);
  const m = norm(city);
  return changes.flatMap(change => {
    if(change.uf !== uf) return [];
    if(z && digits(change.zona) !== z) return [];
    if(m && norm(change.municipio) !== m) return [];
    return allSectionPairs(change).filter(pair => pair.first === s).map(pair => ({ change, pair }));
  });
}

function renderDisambiguation(items, title = 'Escolha a ocorrência correta'){
  const box = $('#lookupMessage');
  box.className = 'lookup-message warning disambiguation';
  box.innerHTML = `<strong>${safe(title)}</strong><div class="disambiguation-list">${items.slice(0,20).map((item, index) => `<button type="button" data-didx="${index}">${safe(item.label)}</button>`).join('')}</div>`;
  items.slice(0,20).forEach((item, index) => box.querySelector(`[data-didx="${index}"]`)?.addEventListener('click', item.action));
}

async function lookupSection(uf, zone, section, city){
  const sectionDigits = digits(section);
  const zoneDigits = digits(zone);
  if(!uf || !sectionDigits){
    showMessage('Informe a UF e a seção em que você votou no 1º turno.', 'warning');
    return;
  }

  const changed = findChanged(uf, zoneDigits, sectionDigits, city);
  if(changed.length === 1){
    selectChange(changed[0].change, changed[0].pair);
    return;
  }

  if(changed.length > 1){
    renderDisambiguation(
      changed.map(item => ({
        label: `${item.change.municipio}/${item.change.uf} · zona ${item.change.zona} · seção ${item.pair.first} → ${item.pair.second}`,
        action: () => selectChange(item.change, item.pair)
      })),
      'Essa seção aparece em mais de uma zona/município. Escolha a ocorrência correta:'
    );
    return;
  }

  const ok = await ensureUfData(uf);
  if(!ok){
    showMessage('Não foi possível carregar a base completa da UF. Confirme seu local no Autoatendimento Eleitoral do TSE.', 'warning');
    return;
  }

  const cityNorm = norm(city);
  const hits = ufSections.filter(row => digits(row.s) === sectionDigits && (!zoneDigits || digits(row.z) === zoneDigits) && (!cityNorm || norm(row.m) === cityNorm));

  if(hits.length === 1){
    const hit = hits[0];
    const location = ufLocations.find(row => row.id === hit.location_id);
    showMessage(`A seção ${sectionDigits}${zoneDigits ? ` da zona ${zoneDigits}` : ''} não aparece na lista de alterações deste snapshot. Exibimos o local cadastrado, mas a confirmação oficial do TSE continua recomendada.`, 'success');
    if(location) selectLocation(location, sectionDigits);
    return;
  }

  if(hits.length > 1){
    renderDisambiguation(
      hits.map(hit => {
        const location = ufLocations.find(row => row.id === hit.location_id);
        return {
          label: `${hit.m}/${hit.u} · zona ${hit.z} · ${location?.n || 'local'}`,
          action: () => location && selectLocation(location, sectionDigits)
        };
      }),
      'O número da seção se repete. Informe a zona/município ou escolha abaixo:'
    );
    return;
  }

  showMessage('Não localizamos essa combinação no snapshot carregado. Confirme diretamente no Autoatendimento Eleitoral do TSE.', 'warning');
}

function renderSearch(rows){
  const box = $('#searchResults');
  const query = $('#search').value.trim();
  if(!query){
    box.innerHTML = '';
    return;
  }
  box.innerHTML = rows.length ? rows.map(row => `
    <div class="search-item ${row.c ? 'changed' : ''}" data-kind="${safe(row.kind)}" data-id="${safe(row.id)}" role="option">
      <span class="pin"></span>
      <div class="search-main">
        <strong>${safe(row.n)}</strong>
        <span>${safe(row.m)}/${safe(row.u)} · Zona ${safe(row.z)} · Seções ${safe((row.s || []).slice(0,8).join(', '))}${(row.s || []).length > 8 ? '…' : ''}</span>
      </div>
      <span class="search-tag">${row.c ? 'mudou' : 'local'}</span>
    </div>
  `).join('') : `<div class="search-item"><div class="search-main"><strong>Nenhum resultado</strong><span>Tente município, escola, endereço, zona ou seção.</span></div></div>`;

  box.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', async () => {
      if(el.dataset.kind === 'change'){
        const change = changes.find(item => item.id === el.dataset.id);
        if(change) selectChange(change);
      } else {
        const location = ufLocations.find(item => item.id === el.dataset.id);
        if(location) selectLocation(location);
      }
      closeOverlay('#searchPanel');
    });
  });
}

function doSearch(){
  worker.postMessage({ type: 'search', payload: { query: $('#search').value, uf: selectedUf || $('#lookupUf').value } });
}

function bindMapInteractions(){
  map.on('click', async (event) => {
    const layers = ['clusters','location-clusters','change-points','location-points','selected-points'].filter(id => map.getLayer(id));
    if(!layers.length) return;
    const feature = map.queryRenderedFeatures(event.point, { layers })[0];
    if(!feature) return;

    const layer = feature.layer.id;
    if(layer === 'clusters' || layer === 'location-clusters'){
      const sourceId = layer === 'clusters' ? 'changes-src' : 'locations-src';
      const zoom = await map.getSource(sourceId).getClusterExpansionZoom(feature.properties.cluster_id);
      map.easeTo({ center: feature.geometry.coordinates, zoom, duration: 900 });
      return;
    }

    if(layer === 'change-points'){
      const row = changePointRows[Number(feature.properties.idx)];
      if(row) selectChange(row.ref);
      return;
    }

    if(layer === 'location-points'){
      const row = locationPointRows[Number(feature.properties.idx)];
      if(row) selectLocation(row);
    }
  });

  map.on('mousemove', (event) => {
    const layers = ['clusters','location-clusters','change-points','location-points'].filter(id => map.getLayer(id));
    const hit = layers.length && map.queryRenderedFeatures(event.point, { layers }).length;
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  });
}

function startPulse(){
  const frame = (time) => {
    if(map.getLayer('change-pulse')){
      const phase = (Math.sin(time / 450) + 1) / 2;
      map.setPaintProperty('change-pulse', 'circle-radius', 11 + phase * 8);
      map.setPaintProperty('change-pulse', 'circle-opacity', 0.46 - phase * 0.32);
    }
    pulseRaf = requestAnimationFrame(frame);
  };
  pulseRaf = requestAnimationFrame(frame);
}

function toggleLookupPanel(){
  const panel = $('#lookupPanel');
  panel.classList.toggle('collapsed');
  $('#toggleLookup').textContent = panel.classList.contains('collapsed') ? '+' : '—';
  $('#toggleLookup').setAttribute('aria-label', panel.classList.contains('collapsed') ? 'Expandir painel' : 'Minimizar painel');
}

async function init(){
  try {
    [meta, changes, summary] = await Promise.all([
      loadJson('./data/meta.json'),
      loadJson('./data/changes.json'),
      loadJson('./data/summary.json').catch(() => [])
    ]);
  } catch (error) {
    console.error(error);
    meta = { demo: true, stale: false, snapshot_at: '', ufs: [] };
    changes = [];
    summary = [];
  }

  if(meta.demo) $('#demoBanner').classList.remove('hidden');
  if(meta.stale) $('#staleBanner').classList.remove('hidden');

  buildTableRows();
  const ufs = (meta.ufs?.length ? meta.ufs : [...new Set(changes.map(change => change.uf))]).sort();
  populateUfSelectors(ufs);

  worker.postMessage({ type: 'initChanges', payload: changes.map(changeSearchRow) });
  updateStats();
  updateSourceStatus();
  renderTable();

  if(map.loaded()){
    ensureMapImages();
    updateBaseMap();
    renderChanges();
    bindMapInteractions();
    startPulse();
  } else {
    map.once('load', () => {
      ensureMapImages();
      updateBaseMap();
      renderChanges();
      bindMapInteractions();
      startPulse();
    });
  }
}

$('#sectionForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const uf = $('#lookupUf').value;
  const zone = $('#lookupZone').value;
  const section = $('#lookupSection').value;
  const city = $('#lookupCity').value;
  selectedUf = uf;
  $('#ufFilter').value = uf;
  updateStats();
  renderMode();
  lookupSection(uf, zone, section, city);
});

$('#lookupUf').addEventListener('change', async (event) => {
  selectedUf = event.target.value;
  $('#ufFilter').value = selectedUf;
  updateStats();
  renderMode();
  if(selectedUf) await ensureUfData(selectedUf);
});

$('#ufFilter').addEventListener('change', async (event) => {
  selectedUf = event.target.value;
  $('#lookupUf').value = selectedUf;
  updateStats();
  renderMode();
  if(!selectedUf){
    map.fitBounds(BR_BOUNDS, { padding: 18, duration: 900, maxZoom: 4.3 });
  } else {
    await ensureUfData(selectedUf);
    fitRows(scopedChanges());
  }
});

$('.layers-panel').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if(!button) return;
  setMode(button.dataset.mode);
  renderMode();
});

$$('.base-btn').forEach(button => {
  button.addEventListener('click', () => {
    $$('.base-btn').forEach(btn => btn.classList.toggle('active', btn === button));
    updateBaseMap();
  });
});

$('#toggleRoute').addEventListener('change', () => {
  if(selectedChange) drawSelection(selectedChange);
});
$('#toggleLabels').addEventListener('change', updateBaseMap);

$('#brandHome').addEventListener('click', (event) => {
  event.preventDefault();
  selectedUf = '';
  $('#lookupUf').value = '';
  $('#lookupCity').value = '';
  $('#lookupZone').value = '';
  $('#lookupSection').value = '';
  $('#ufFilter').value = '';
  $('#lookupMessage').classList.add('hidden');
  setMode('changes');
  updateStats();
  renderChanges();
  $('#drawer').classList.remove('open');
  map.fitBounds(BR_BOUNDS, { padding: 18, duration: 1100, maxZoom: 4.3 });
});

$('#toggleLookup').addEventListener('click', toggleLookupPanel);
$('#closeDrawer').addEventListener('click', () => $('#drawer').classList.remove('open'));
$('#aboutBtn').addEventListener('click', () => showOverlay('#about'));
$('#closeAbout').addEventListener('click', () => closeOverlay('#about'));
$('#about').addEventListener('click', (event) => { if(event.target.id === 'about') closeOverlay('#about'); });

$('#searchBtn').addEventListener('click', async () => {
  const uf = selectedUf || $('#lookupUf').value;
  if(uf) await ensureUfData(uf);
  showOverlay('#searchPanel');
  requestAnimationFrame(() => $('#search').focus());
});
$('#closeSearch').addEventListener('click', () => closeOverlay('#searchPanel'));
$('#searchPanel').addEventListener('click', (event) => { if(event.target.id === 'searchPanel') closeOverlay('#searchPanel'); });
$('#search').addEventListener('input', doSearch);
$('#search').addEventListener('focus', doSearch);

$('#tableBtn').addEventListener('click', () => { renderTable(); showOverlay('#tablePanel'); });
$('#closeTable').addEventListener('click', () => closeOverlay('#tablePanel'));
$('#tablePanel').addEventListener('click', (event) => { if(event.target.id === 'tablePanel') closeOverlay('#tablePanel'); });
$('#tableSearch').addEventListener('input', renderTable);
$('#tableUfFilter').addEventListener('change', renderTable);

document.addEventListener('keydown', (event) => {
  if(event.key === 'Escape'){
    closeOverlay('#about');
    closeOverlay('#searchPanel');
    closeOverlay('#tablePanel');
    $('#drawer').classList.remove('open');
  }
});

init();
