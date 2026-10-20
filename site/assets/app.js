const $ = s => document.querySelector(s);
const norm = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
const digits = v => String(v ?? '').replace(/\D/g,'').replace(/^0+(?=\d)/,'');
const safe = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = n => new Intl.NumberFormat('pt-BR').format(Number(n||0));
const BR_CENTER=[-52.6,-14.2];

const map=new maplibregl.Map({
  container:'map',center:BR_CENTER,zoom:3.25,minZoom:2.5,maxZoom:18,attributionControl:true,
  style:{version:8,sources:{base:{type:'raster',tiles:['https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png?key=__CARTO_BASEMAP_KEY__'],tileSize:256,attribution:'© OpenStreetMap contributors, © CARTO'}},layers:[{id:'base',type:'raster',source:'base',paint:{'raster-opacity':.94}}]}
});
map.addControl(new maplibregl.NavigationControl({showCompass:false}),'bottom-right');

let meta={},changes=[],summary=[],mode='changes',selectedUf='',loadedUf='';
let ufSections=[],ufLocations=[];
let changePointRows=[],locationPointRows=[];
let pulseRaf=null;
const worker=new Worker('./assets/search-worker.js');
worker.onmessage=({data})=>{if(data.type==='results') renderSearch(data.results)};

async function loadJson(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(`${path}: ${r.status}`);return r.json()}
function validCoord(lat,lng){return Number.isFinite(+lat)&&Number.isFinite(+lng)&&Math.abs(+lat)<=90&&Math.abs(+lng)<=180}
function parseDateLabel(v){if(!v)return '—';const d=new Date(v);return Number.isNaN(d.valueOf())?v:d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
function allSectionPairs(c){
  if(Array.isArray(c.section_map)&&c.section_map.length)return c.section_map.map(x=>({first:digits(x.first),second:digits(x.second||x.first)}));
  return (c.sections||[]).map(s=>({first:digits(s),second:digits(s)}));
}
function changeSectionsFirst(c){return allSectionPairs(c).map(x=>x.first).filter(Boolean)}
function changeSearchRow(c){
  const s=changeSectionsFirst(c);
  return {id:c.id,kind:'change',u:c.uf,m:c.municipio,z:String(c.zona),n:c.new_name||c.old_name||'Local alterado',a:c.new_address||'',s,c:true,lat:c.new_lat,lng:c.new_lng,q:norm(`${c.municipio} ${c.uf} ${c.zona} ${s.join(' ')} ${c.old_name||''} ${c.new_name||''} ${c.old_address||''} ${c.new_address||''}`)};
}
function locationSearchRow(l){return{id:l.id,kind:'location',u:l.u,m:l.m,z:String(l.z),n:l.n,a:l.a||'',s:l.s||[],c:false,lat:l.lat,lng:l.lng,q:norm(`${l.m} ${l.u} ${l.z} ${(l.s||[]).join(' ')} ${l.n||''} ${l.a||''} ${l.b||''}`)}}

async function init(){
  try{[meta,changes,summary]=await Promise.all([loadJson('./data/meta.json'),loadJson('./data/changes.json'),loadJson('./data/summary.json').catch(()=>[])])}
  catch(e){console.error(e);meta={demo:true,ufs:[]};changes=[];summary=[]}
  if(meta.demo)$('#demoBanner').classList.remove('hidden');
  if(meta.stale)$('#staleBanner').classList.remove('hidden');
  const ufs=(meta.ufs?.length?meta.ufs:[...new Set(changes.map(x=>x.uf))]).sort();
  for(const sel of [$('#lookupUf'),$('#ufFilter')])sel.insertAdjacentHTML('beforeend',ufs.map(u=>`<option value="${safe(u)}">${safe(u)}</option>`).join(''));
  worker.postMessage({type:'initChanges',payload:changes.map(changeSearchRow)});
  updateStats();
  updateSourceStatus();
  if(map.loaded()){renderChanges();bindMapInteractions();startPulse()}else map.once('load',()=>{renderChanges();bindMapInteractions();startPulse()});
}

function updateSourceStatus(){
  const el=$('#sourceStatus');
  if(!el)return;
  const label=parseDateLabel(meta.snapshot_at);
  const src=meta.source_kind==='official-tse-open-data-derived'?'dados abertos TSE':'snapshot TSE';
  el.innerHTML=`<span class="live-dot ${meta.stale?'stale':''}"></span><strong>${meta.stale?'último snapshot disponível':src}</strong> ${safe(label)}`;
}
function updateStats(){
  const rows=selectedUf?changes.filter(c=>c.uf===selectedUf):changes;
  $('#statSections').textContent=fmt(rows.reduce((n,c)=>n+changeSectionsFirst(c).length,0));
  $('#statCities').textContent=fmt(new Set(rows.filter(c=>c.municipio).map(c=>`${c.uf}|${c.municipio}`)).size);
  $('#statUpdated').textContent=parseDateLabel(meta.snapshot_at).split(',')[0];
}
function removeLayer(id){if(map.getLayer(id))map.removeLayer(id)}
function removeSource(id){if(map.getSource(id))map.removeSource(id)}
function clearMapLayers(){
  ['cluster-count','clusters','change-pulse','change-points','location-cluster-count','location-clusters','location-points','selected-line','selected-points'].forEach(removeLayer);
  ['changes-src','locations-src','selected-line-src','selected-points-src'].forEach(removeSource);
  changePointRows=[];locationPointRows=[];
}
function fitRows(rows){
  const pts=rows.filter(r=>validCoord(r.new_lat??r.lat,r.new_lng??r.lng));if(!pts.length)return;
  const b=new maplibregl.LngLatBounds();pts.forEach(r=>b.extend([+(r.new_lng??r.lng),+(r.new_lat??r.lat)]));
  if(pts.length===1)map.flyTo({center:b.getCenter(),zoom:13,duration:1400,curve:1.45});
  else map.fitBounds(b,{padding:90,maxZoom:8,duration:1200});
}
function addClusteredSource(sourceId,rows,kind){
  const features=rows.filter(r=>validCoord(r.lng,r.lat)).map((r,i)=>({type:'Feature',geometry:{type:'Point',coordinates:[+r.lng,+r.lat]},properties:{idx:i}}));
  map.addSource(sourceId,{type:'geojson',data:{type:'FeatureCollection',features},cluster:true,clusterRadius:48,clusterMaxZoom:10});
  const prefix=kind==='changes'?'':'location-';
  map.addLayer({id:`${prefix}clusters`,type:'circle',source:sourceId,filter:['has','point_count'],paint:{'circle-color':kind==='changes'?'#ffc95b':'#65a8ff','circle-radius':['step',['get','point_count'],17,20,22,100,29],'circle-opacity':.9,'circle-stroke-width':2,'circle-stroke-color':'rgba(255,255,255,.65)'}});
  map.addLayer({id:`${prefix}cluster-count`,type:'symbol',source:sourceId,filter:['has','point_count'],layout:{'text-field':['get','point_count_abbreviated'],'text-size':11},paint:{'text-color':kind==='changes'?'#201707':'#061426'}});
  if(kind==='changes')map.addLayer({id:'change-pulse',type:'circle',source:sourceId,filter:['!',['has','point_count']],paint:{'circle-radius':12,'circle-color':'rgba(255,201,91,0)','circle-stroke-width':2,'circle-stroke-color':'#ffc95b','circle-opacity':.35}});
  map.addLayer({id:kind==='changes'?'change-points':'location-points',type:'circle',source:sourceId,filter:['!',['has','point_count']],paint:{'circle-radius':kind==='changes'?7:5,'circle-color':kind==='changes'?'#ffc95b':'#65a8ff','circle-stroke-width':2,'circle-stroke-color':'#fff','circle-opacity':.97}});
}
function renderChanges(){
  clearMapLayers();
  const base=selectedUf?changes.filter(c=>c.uf===selectedUf):changes;
  changePointRows=base.filter(c=>validCoord(c.new_lat,c.new_lng)).map(c=>({ref:c,lng:c.new_lng,lat:c.new_lat}));
  if(changePointRows.length)addClusteredSource('changes-src',changePointRows,'changes');
}
async function ensureUfData(uf){
  if(!uf)return false;if(loadedUf===uf)return true;
  try{
    [ufSections,ufLocations]=await Promise.all([loadJson(`./data/sections/${uf}.json`),loadJson(`./data/locations/${uf}.json`)]);
    loadedUf=uf;
    worker.postMessage({type:'setUf',payload:ufLocations.map(locationSearchRow)});
    const cities=[...new Set(ufSections.map(x=>x.m).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    $('#cityOptions').innerHTML=cities.map(c=>`<option value="${safe(c)}"></option>`).join('');
    return true;
  }catch(e){console.warn('UF shard indisponível',uf,e);ufSections=[];ufLocations=[];loadedUf=uf;worker.postMessage({type:'setUf',payload:[]});return false}
}
async function renderAll(){
  clearMapLayers();
  if(!selectedUf){showMessage('Escolha uma UF para abrir a camada com todos os locais. O mapa nacional permanece focado nas mudanças do 2º turno.','warning');setMode('changes');renderChanges();return}
  await ensureUfData(selectedUf);
  locationPointRows=ufLocations.filter(r=>validCoord(r.lat,r.lng));
  if(locationPointRows.length)addClusteredSource('locations-src',locationPointRows,'locations');
}
function setMode(v){mode=v;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===v))}
function renderMode(){mode==='all'?renderAll():renderChanges()}
function fly(lat,lng,zoom=15){if(validCoord(lat,lng))map.flyTo({center:[+lng,+lat],zoom,duration:1700,curve:1.65,essential:true})}
function drawSelection(c){
  removeLayer('selected-line');removeSource('selected-line-src');removeLayer('selected-points');removeSource('selected-points-src');
  const features=[];
  if(validCoord(c.old_lat,c.old_lng))features.push({type:'Feature',geometry:{type:'Point',coordinates:[+c.old_lng,+c.old_lat]},properties:{kind:'old'}});
  if(validCoord(c.new_lat,c.new_lng))features.push({type:'Feature',geometry:{type:'Point',coordinates:[+c.new_lng,+c.new_lat]},properties:{kind:'new'}});
  if(features.length){
    map.addSource('selected-points-src',{type:'geojson',data:{type:'FeatureCollection',features}});
    map.addLayer({id:'selected-points',type:'circle',source:'selected-points-src',paint:{'circle-radius':['match',['get','kind'],'new',10,7],'circle-color':['match',['get','kind'],'new','#4ee1a0','#ffffff'],'circle-stroke-color':['match',['get','kind'],'new','#ffffff','#ffc95b'],'circle-stroke-width':3}});
  }
  if(validCoord(c.old_lat,c.old_lng)&&validCoord(c.new_lat,c.new_lng)&&!(Math.abs(+c.old_lat-+c.new_lat)<.00001&&Math.abs(+c.old_lng-+c.new_lng)<.00001)){
    map.addSource('selected-line-src',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:[[+c.old_lng,+c.old_lat],[+c.new_lng,+c.new_lat]]},properties:{}}});
    map.addLayer({id:'selected-line',type:'line',source:'selected-line-src',paint:{'line-color':'#ffc95b','line-width':3,'line-opacity':.75,'line-dasharray':[1.3,1.2]}});
  }
}
function openDrawer(html){$('#drawerContent').innerHTML=html;$('#drawer').classList.add('open');$('#drawer').setAttribute('aria-hidden','false')}
function mapsUrl(c){return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.new_name||''} ${c.new_address||''} ${c.municipio||''} ${c.uf||''}`)}`}
function selectChange(c,pair=null){
  pair=pair||allSectionPairs(c)[0]||{first:'',second:''};
  fly(c.new_lat,c.new_lng,15);drawSelection(c);
  const renumber=pair.first&&pair.second&&pair.first!==pair.second;
  const moved=(norm(c.old_address)!==norm(c.new_address)||norm(c.old_name)!==norm(c.new_name));
  const title=renumber?'Sua seção também mudou de número':moved?'Você vota em outro local no 2º turno':'O TSE registrou uma alteração';
  const pairs=allSectionPairs(c).map(x=>`<span>${safe(x.first)}${x.first!==x.second?` → ${safe(x.second)}`:''}</span>`).join('');
  const electors=c.electors?` · ${fmt(c.electors)} eleitores neste grupo`:'';
  openDrawer(`<div class="status-badge changed">ALTERAÇÃO ENTRE OS TURNOS</div><h2>${safe(title)}</h2><div class="meta">${safe(c.municipio)}/${safe(c.uf)} · ${safe(c.zona)}ª Zona Eleitoral${electors}</div>${pair.first?`<div class="section-change"><div class="section-number"><small>1º turno</small><strong>${safe(pair.first)}</strong></div><div class="arrow">→</div><div class="section-number"><small>2º turno</small><strong>${safe(pair.second||pair.first)}</strong></div></div>`:''}<div class="route"><div class="route-card old"><label>Onde você votou no 1º turno</label><strong>${safe(c.old_name||'Local anterior')}</strong><p>${safe(c.old_address||'Endereço não informado no relatório')}</p></div><div class="route-arrow">↓</div><div class="route-card new"><label>Onde votar no 2º turno</label><strong>${safe(c.new_name||'Confirme no TSE')}</strong><p>${safe(c.new_address||'Endereço ainda não disponível nesta base')}</p></div></div><p class="eyebrow">SEÇÕES TRANSFERIDAS NESTE GRUPO</p><div class="section-pills">${pairs}</div><div class="drawer-actions"><a class="primary" href="${mapsUrl(c)}" target="_blank" rel="noreferrer">Abrir novo local ↗</a><a href="https://www.tse.jus.br/servicos-eleitorais/autoatendimento-eleitoral#/" target="_blank" rel="noreferrer">Confirmar no TSE ↗</a></div><p class="source-note">Fonte: ${safe(c.source||'Justiça Eleitoral')}. Atualização: ${safe(parseDateLabel(meta.snapshot_at))}. ${meta.stale?'Esta publicação usou o último snapshot disponível porque o painel não exportou na atualização mais recente. ':''}Em caso de divergência, prevalece o e-Título/Autoatendimento Eleitoral.</p>`);
  showMessage(`A seção ${pair.first} aparece na lista de alterações do TSE. O novo local está destacado no mapa.`,'success');
}
function selectLocation(r,section=''){
  fly(r.lat,r.lng,15);
  const maps=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.n} ${r.a||''} ${r.m} ${r.u}`)}`;
  openDrawer(`<div class="status-badge same">NÃO CONSTA NESTE SNAPSHOT DE MUDANÇAS</div><h2>${safe(r.n)}</h2><div class="meta">${safe(r.m)}/${safe(r.u)} · ${safe(r.z)}ª Zona Eleitoral</div>${section?`<div class="section-number single"><small>Seção consultada</small><strong>${safe(section)}</strong></div>`:''}<div class="route-card new"><label>Local cadastrado para 2026</label><strong>${safe(r.a||'Endereço não informado')}</strong><p>Local nº ${safe(r.l||'—')}</p></div><div class="drawer-actions"><a class="primary" href="${maps}" target="_blank" rel="noreferrer">Abrir local ↗</a><a href="https://www.tse.jus.br/servicos-eleitorais/autoatendimento-eleitoral#/" target="_blank" rel="noreferrer">Confirmar no TSE ↗</a></div><p class="source-note">Não aparecer na lista de alterações significa apenas que esta combinação não consta no snapshot carregado. O TSE orienta conferir o local pelos canais oficiais antes de sair.</p>`);
}
function showMessage(text,type=''){const el=$('#lookupMessage');el.textContent=text;el.className=`lookup-message ${type}`;el.classList.remove('hidden')}
function findChanged(uf,zone,section,city){
  const z=digits(zone),s=digits(section),m=norm(city);
  return changes.flatMap(c=>{
    if(c.uf!==uf)return[];
    if(z&&digits(c.zona)!==z)return[];
    if(m&&norm(c.municipio)!==m)return[];
    return allSectionPairs(c).filter(p=>p.first===s).map(pair=>({c,pair}));
  });
}
function renderDisambiguation(items,title='Escolha a ocorrência correta'){
  const box=$('#lookupMessage');
  box.className='lookup-message warning disambiguation';
  box.innerHTML=`<strong>${safe(title)}</strong><div class="disambiguation-list">${items.slice(0,20).map((x,i)=>`<button type="button" data-didx="${i}">${safe(x.label)}</button>`).join('')}</div>`;
  items.slice(0,20).forEach((x,i)=>box.querySelector(`[data-didx="${i}"]`)?.addEventListener('click',x.action));
}
async function lookupSection(uf,zone,section,city){
  const s=digits(section),z=digits(zone);if(!uf||!s){showMessage('Informe a UF e a seção em que você votou no 1º turno.','warning');return}
  const changed=findChanged(uf,z,s,city);
  if(changed.length===1){selectChange(changed[0].c,changed[0].pair);return}
  if(changed.length>1){
    renderDisambiguation(changed.map(x=>({label:`${x.c.municipio}/${x.c.uf} · zona ${x.c.zona} · seção ${x.pair.first} → ${x.pair.second}`,action:()=>selectChange(x.c,x.pair)})),'Essa seção aparece em mais de uma zona/município. Escolha a sua:');
    return;
  }
  const ok=await ensureUfData(uf);if(!ok){showMessage('Não foi possível carregar a base completa da UF. Confirme seu local no e-Título ou no Autoatendimento Eleitoral.','warning');return}
  const cityNorm=norm(city);
  const hits=ufSections.filter(r=>digits(r.s)===s&&(!z||digits(r.z)===z)&&(!cityNorm||norm(r.m)===cityNorm));
  if(hits.length===1){
    const hit=hits[0],loc=ufLocations.find(l=>l.id===hit.location_id);
    showMessage(`A seção ${s}${z?` da zona ${z}`:''} não aparece na lista de alterações deste snapshot. Mostramos o local cadastrado para 2026; confirme no TSE antes de sair.`,'success');
    if(loc)selectLocation(loc,s);return;
  }
  if(hits.length>1){
    renderDisambiguation(hits.map(hit=>{const loc=ufLocations.find(l=>l.id===hit.location_id);return{label:`${hit.m}/${hit.u} · zona ${hit.z} · ${loc?.n||'local'}`,action:()=>loc&&selectLocation(loc,s)}}),'O número da seção se repete. Informe a zona/município ou escolha abaixo:');
    return;
  }
  showMessage('Não localizamos essa combinação no snapshot carregado. Confirme diretamente no e-Título ou Autoatendimento Eleitoral.','warning');
}
function renderSearch(rows){
  const box=$('#searchResults');if(!$('#search').value.trim()){box.classList.add('hidden');return}
  box.innerHTML=rows.length?rows.map(r=>`<div class="search-item ${r.c?'changed':''}" data-kind="${safe(r.kind)}" data-id="${safe(r.id)}" role="option"><span class="pin"></span><div class="search-main"><strong>${safe(r.n)}</strong><span>${safe(r.m)}/${safe(r.u)} · Zona ${safe(r.z)} · Seções ${safe((r.s||[]).slice(0,8).join(', '))}${(r.s||[]).length>8?'…':''}</span></div><span class="search-tag">${r.c?'mudou':'local'}</span></div>`).join(''):'<div class="search-item"><div class="search-main"><strong>Nenhum resultado</strong><span>Tente município, escola, endereço, zona ou seção.</span></div></div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>{
    if(el.dataset.kind==='change'){const c=changes.find(x=>x.id===el.dataset.id);if(c)selectChange(c)}
    else{const l=ufLocations.find(x=>x.id===el.dataset.id);if(l)selectLocation(l)}
    box.classList.add('hidden');
  }));
}
function doSearch(){worker.postMessage({type:'search',payload:{query:$('#search').value,uf:selectedUf||$('#lookupUf').value}})}
function bindMapInteractions(){
  map.on('click',async e=>{
    const layers=['clusters','location-clusters','change-points','location-points'].filter(id=>map.getLayer(id));
    if(!layers.length)return;
    const f=map.queryRenderedFeatures(e.point,{layers})[0];if(!f)return;
    const layer=f.layer.id;
    if(layer==='clusters'||layer==='location-clusters'){
      const sourceId=layer==='clusters'?'changes-src':'locations-src';
      const z=await map.getSource(sourceId).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({center:f.geometry.coordinates,zoom:z,duration:800});return;
    }
    if(layer==='change-points'){const r=changePointRows[Number(f.properties.idx)];if(r)selectChange(r.ref);return}
    if(layer==='location-points'){const r=locationPointRows[Number(f.properties.idx)];if(r)selectLocation(r)}
  });
  map.on('mousemove',e=>{
    const layers=['clusters','location-clusters','change-points','location-points'].filter(id=>map.getLayer(id));
    const hit=layers.length&&map.queryRenderedFeatures(e.point,{layers}).length;
    map.getCanvas().style.cursor=hit?'pointer':'';
  });
}
function startPulse(){
  const frame=t=>{
    if(map.getLayer('change-pulse')){
      const phase=(Math.sin(t/450)+1)/2;
      map.setPaintProperty('change-pulse','circle-radius',10+phase*8);
      map.setPaintProperty('change-pulse','circle-opacity',.48-phase*.38);
    }
    pulseRaf=requestAnimationFrame(frame);
  };
  pulseRaf=requestAnimationFrame(frame);
}

$('#sectionForm').addEventListener('submit',e=>{
  e.preventDefault();const uf=$('#lookupUf').value,z=$('#lookupZone').value,s=$('#lookupSection').value,city=$('#lookupCity').value;
  selectedUf=uf;$('#ufFilter').value=uf;updateStats();renderMode();lookupSection(uf,z,s,city);
});
$('#search').addEventListener('input',doSearch);$('#search').addEventListener('focus',doSearch);
$('#lookupUf').addEventListener('change',async e=>{selectedUf=e.target.value;$('#ufFilter').value=selectedUf;updateStats();renderMode();if(selectedUf)await ensureUfData(selectedUf)});
$('#ufFilter').addEventListener('change',async e=>{selectedUf=e.target.value;$('#lookupUf').value=selectedUf;updateStats();renderMode();if(!selectedUf)map.flyTo({center:BR_CENTER,zoom:3.25,duration:1000});else{await ensureUfData(selectedUf);fitRows(changes.filter(c=>c.uf===selectedUf))}});
document.querySelector('.map-controls').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(!b)return;setMode(b.dataset.mode);renderMode()});
$('#brandHome').addEventListener('click',e=>{e.preventDefault();selectedUf='';$('#lookupUf').value='';$('#lookupCity').value='';$('#lookupZone').value='';$('#lookupSection').value='';$('#ufFilter').value='';setMode('changes');updateStats();renderChanges();map.flyTo({center:BR_CENTER,zoom:3.25,duration:1100})});
$('#closeDrawer').addEventListener('click',()=>$('#drawer').classList.remove('open'));
$('#aboutBtn').addEventListener('click',()=>$('#about').classList.remove('hidden'));
$('#closeAbout').addEventListener('click',()=>$('#about').classList.add('hidden'));
$('#about').addEventListener('click',e=>{if(e.target.id==='about')$('#about').classList.add('hidden')});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))$('#searchResults').classList.add('hidden')});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#searchResults').classList.add('hidden');$('#drawer').classList.remove('open');$('#about').classList.add('hidden')}});
init();
