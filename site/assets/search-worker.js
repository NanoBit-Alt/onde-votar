let changeRows=[];
let ufRows=[];
const norm=(s='')=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function allRows(){return changeRows.concat(ufRows)}
self.onmessage=ev=>{
  const {type,payload}=ev.data||{};
  if(type==='initChanges'){changeRows=payload||[];self.postMessage({type:'ready',count:changeRows.length});return}
  if(type==='setUf'){ufRows=payload||[];return}
  if(type!=='search')return;
  const q=norm(payload?.query||'');
  const uf=payload?.uf||'';
  if(!q){self.postMessage({type:'results',results:[]});return}
  const tokens=q.split(' ').filter(Boolean);
  const scored=[];
  for(const r of allRows()){
    if(uf&&r.u!==uf)continue;
    const hay=(r.q||norm(`${r.n||''} ${r.m||''} ${r.a||''} ${r.z||''} ${(r.s||[]).join(' ')}`)).toLowerCase();
    let score=0,ok=true;
    for(const t of tokens){
      const i=hay.indexOf(t);
      if(i<0){ok=false;break}
      score+=i===0?9:i<24?5:2;
    }
    if(!ok)continue;
    if(r.c)score+=8;
    if(norm(r.m).startsWith(q))score+=6;
    if(norm(r.n).startsWith(q))score+=6;
    if((r.s||[]).includes(q.replace(/\D/g,'')))score+=10;
    scored.push([score,r]);
  }
  scored.sort((a,b)=>b[0]-a[0]||String(a[1].m).localeCompare(String(b[1].m),'pt-BR'));
  self.postMessage({type:'results',results:scored.slice(0,24).map(x=>x[1])});
};
