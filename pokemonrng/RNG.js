// RNG.js - simple Pokédex RNG simulator
// Minimal, dependency-free script. Uses PokéAPI (https://pokeapi.co/) to fetch basic data.

const API_BASE = 'https://pokeapi.co/api/v2';
const STORAGE_KEY = 'pokedex_v1';

// UI elements
const el = id => document.getElementById(id);
const btnEncounter = el('btn-encounter');
const btnRandom3 = el('btn-random3');
const btnCatch = el('btn-catch');
const btnRun = el('btn-run');
const btnExport = el('btn-export');
const btnImport = el('btn-import');
const btnReset = el('btn-reset');
const pokeImage = el('poke-image');
const pokeName = el('poke-name');
const pokeId = el('poke-id');
const pokeTypes = el('poke-types');
const pokedexEl = el('pokedex');
const caughtCountEl = el('caught-count');
const totalCountEl = el('total-count');
const progressBar = el('progress-bar');
const legendaryCountEl = el('legendary-count');
const pageNumEl = el('page-num');
const pageTotalEl = el('page-total');
const pageSizeEl = el('page-size');
const searchEl = el('search');
const toastEl = el('toast');
const modal = el('modal');
const modalBody = el('modal-body');
const modalClose = el('modal-close');
const typeFilter = el('type-filter');
const ballSelect = el('ball-select');
const ballInventoryEl = el('ball-inventory');
const pokeballEl = el('pokeball');
const countPokeballEl = el('count-pokeball');
const countGreatEl = el('count-greatball');
const countUltraEl = el('count-ultraball');

let pokedex = {}; // {id: {id,name,caught,types,is_legendary}}
// use -1 for infinite pokeballs
let inventory = { pokeball:-1, greatball:2, ultraball:1 };
let captureCounter = 0; // total unique captures (used for granting bonuses)
let currentEncounter = null;
let allCount = 151;
let page = 1;
let isProcessing = false; // prevents double actions while resolving capture/flee
let isFetchingEncounter = false; // prevents concurrent encounter fetches
let _processingTimer = null;
function startProcessing(){
  isProcessing = true;
  if(_processingTimer) clearTimeout(_processingTimer);
  _processingTimer = setTimeout(()=>{
    console.warn('watchdog: clearing isProcessing due to timeout');
    isProcessing = false;
    _processingTimer = null;
  }, 6000);
}
function stopProcessing(){
  isProcessing = false;
  if(_processingTimer){ clearTimeout(_processingTimer); _processingTimer = null; }
}

async function init(){
  // load stored
  const raw = localStorage.getItem(STORAGE_KEY);
  if(raw){
    try{ pokedex = JSON.parse(raw); }catch(e){ pokedex = {}; }
  }

  // try to get total (use 151 by default for Gen 1)
  try{
    const res = await fetch(`${API_BASE}/pokemon?limit=1`);
    const data = await res.json();
    if(data.count) allCount = Math.min(data.count, 1008); // clamp
  }catch(e){ /* ignore */ }

  totalCountEl.textContent = allCount;
  updateStats();
  populateTypeFilter();
  renderPokedex();
  loadInventory();
  attachHandlers();
}

function attachHandlers(){
  btnEncounter.addEventListener('click', encounterRandom);
  btnRandom3.addEventListener('click', ()=>{ encounterRandom(); setTimeout(encounterRandom,250); setTimeout(encounterRandom,500); });
  // ensure capture button has a handler (defensive attach)
  if(btnCatch){
    try{ btnCatch.removeEventListener('click', tryCatch); }catch(e){}
    btnCatch.addEventListener('click', tryCatch);
    // initial state
    btnCatch.disabled = true;
  }
  btnRun.addEventListener('click', runAway);
  btnExport.addEventListener('click', exportPokedex);
  btnImport.addEventListener('click', importPokedex);
  btnReset.addEventListener('click', resetPokedex);
  pageSizeEl.addEventListener('change', ()=>{ page = 1; renderPokedex(); });
  document.getElementById('next-page').addEventListener('click', ()=>{ page++; renderPokedex(); });
  document.getElementById('prev-page').addEventListener('click', ()=>{ page = Math.max(1,page-1); renderPokedex(); });
  searchEl.addEventListener('input', debounce(()=>{ page = 1; renderPokedex(); }, 300));
  modalClose.addEventListener('click', ()=>{ modal.setAttribute('aria-hidden','true'); });
  typeFilter.addEventListener('change', ()=>{ page=1; renderPokedex(); });
  ballSelect && ballSelect.addEventListener('change', ()=>{});
}

function setToast(msg, timeout=2000){
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=>toastEl.classList.remove('show'), timeout);
}

// small capture sound using WebAudio API (synth chime)
function playCaptureSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime);
    g.gain.setValueAtTime(0, ctx.currentTime);
    o.connect(g); g.connect(ctx.destination);
    // quick envelope
    const now = ctx.currentTime;
    g.gain.linearRampToValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.01);
    o.start(now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    o.frequency.exponentialRampToValueAtTime(1320, now + 0.35);
    setTimeout(()=>{ try{o.stop(); ctx.close();}catch(e){} }, 500);
  }catch(e){}
}

function save(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pokedex));
    updateStats();
  }catch(e){
    console.warn('save() failed, attempting compact save', e);
    try{
      // fallback: save only captured entries to reduce size
      const compact = Object.fromEntries(Object.entries(pokedex).filter(([k,v])=>v && v.caught));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
      updateStats();
      setToast('Espaço de armazenamento cheio — salvando apenas Pokémons capturados', 3000);
    }catch(e2){
      console.warn('compact save failed', e2);
      try{
        // minimal fallback: store only metadata (counts + inventory)
        const meta = { caught: Object.values(pokedex).filter(p=>p.caught).length, captureCounter };
        localStorage.setItem(STORAGE_KEY + '_meta', JSON.stringify(meta));
        setToast('Armazenamento cheio — salvando apenas metadados', 3000);
      }catch(e3){
        console.error('all save fallbacks failed', e3);
        // last resort: clear localStorage keys used by app to recover
        try{ localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(STORAGE_KEY + '_inv'); }catch(e4){}
        setToast('Erro: armazenamento do navegador cheio. Dados antigos podem ter sido apagados.', 4000);
      }
    }
  }
}

function saveInventory(){
  const payload = { inventory, captureCounter };
  try{
    localStorage.setItem(STORAGE_KEY + '_inv', JSON.stringify(payload));
    renderInventory();
  }catch(e){
    console.warn('saveInventory failed', e);
    try{
      // attempt compact inventory-only save
      localStorage.setItem(STORAGE_KEY + '_inv_small', JSON.stringify({ captureCounter }));
      setToast('Espaço de armazenamento insuficiente para salvar inventário completo', 3000);
    }catch(e2){
      console.error('saveInventory fallbacks failed', e2);
      setToast('Erro ao salvar inventário — armazenamento cheio', 3500);
    }
    renderInventory();
  }
}

function loadInventory(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY + '_inv');
    if(raw){
      const data = JSON.parse(raw);
      // support old format (inventory object) and new format { inventory, captureCounter }
      if(data && typeof data === 'object'){
        if(data.inventory){
          inventory = { ...inventory, ...data.inventory };
          captureCounter = data.captureCounter || captureCounter;
        } else {
          // old format
          inventory = { ...inventory, ...data };
        }
      }
    }
  }catch(e){ }
  renderInventory();
}

function renderInventory(){
  if(!ballInventoryEl) return;
  const p = inventory.pokeball === -1 ? '∞' : String(inventory.pokeball||0);
  if(countPokeballEl) countPokeballEl.textContent = p;
  if(countGreatEl) countGreatEl.textContent = String(inventory.greatball||0);
  if(countUltraEl) countUltraEl.textContent = String(inventory.ultraball||0);
  // disable visuals when zero
  const ballEl = el('ball-greatball'); if(ballEl) ballEl.setAttribute('aria-disabled', (inventory.greatball||0) <= 0 ? 'true' : 'false');
  const ultraEl = el('ball-ultraball'); if(ultraEl) ultraEl.setAttribute('aria-disabled', (inventory.ultraball||0) <= 0 ? 'true' : 'false');
  // show/hide infinite badge for pokeball
  try{
    const inf = document.querySelector('#ball-pokeball .infinite-badge');
    if(inf) inf.style.display = (inventory.pokeball === -1) ? 'inline-flex' : 'none';
  }catch(e){}
}

function updateStats(){
  const caught = Object.values(pokedex).filter(p=>p.caught).length;
  const leg = Object.values(pokedex).filter(p=>p.is_legendary && p.caught).length;
  if(caughtCountEl) caughtCountEl.textContent = caught;
  if(legendaryCountEl) legendaryCountEl.textContent = leg;
  // ensure total count is visible
  if(totalCountEl) totalCountEl.textContent = allCount;
  const pct = Math.round((caught / Math.max(1, allCount)) * 100);
  // update progress bar if present; be defensive
  try{
    if(progressBar){ progressBar.style.transition = progressBar.style.transition || 'width 420ms ease'; progressBar.style.width = pct + '%'; }
    else {
      const bar = document.querySelector('.progress > i'); if(bar) { bar.style.transition = bar.style.transition || 'width 420ms ease'; bar.style.width = pct + '%'; }
    }
  }catch(e){ console.warn('updateStats: could not update progress bar', e); }
}

function renderPokedex(){
  const pageSize = parseInt(pageSizeEl.value,10)||48;
  const query = searchEl.value.trim().toLowerCase();
  const type = typeFilter.value;

  // build list of numbers
  let ids = Array.from({length:allCount}, (_,i)=>i+1);

  if(query){
    ids = ids.filter(id=>{
      const p = pokedex[id];
      if(p && p.name) return p.name.toLowerCase().includes(query) || String(id)===query;
      return String(id).includes(query);
    });
  }
  if(type){
    ids = ids.filter(id=>{
      const p = pokedex[id];
      if(!p) return false;
      return (p.types||[]).includes(type);
    });
  }

  const totalPages = Math.max(1, Math.ceil(ids.length / pageSize));
  if(page>totalPages) page = totalPages;
  pageNumEl.textContent = page;
  pageTotalEl.textContent = totalPages;

  const start = (page-1)*pageSize; const end = start + pageSize;
  const slice = ids.slice(start,end);

  pokedexEl.innerHTML = '';
  slice.forEach(id=>{
    const item = document.createElement('div');
    item.className = 'dex-cell';
    const p = pokedex[id];
    if(!p || !p.caught){ item.classList.add('empty'); item.innerHTML = `#${id}`; }
    else{
      item.classList.add('captured');
      const img = p.sprite ? `<img class="pixel" src="${p.sprite}" alt="${p.name}" />` : '';
      const shinyBadge = p.shiny ? `<div class="shiny-badge">Shiny</div>` : '';
      const date = p.capturedAt ? `<div class="captured-date">${new Date(p.capturedAt).toLocaleDateString()}</div>` : '';
      item.innerHTML = `<div style="position:relative">${img}${shinyBadge}</div><div style="font-weight:600">${p.name}</div><div style="font-size:11px;color:#666">#${id}</div>${date}`;
    }
    item.addEventListener('click', ()=> showPokemon(id));
    pokedexEl.appendChild(item);
  });
}

async function showPokemon(id){
  // ensure we have data
  if(!pokedex[id]){
    try{
      const data = await fetchPokemon(id);
      pokedex[id] = { id: data.id, name: capitalize(data.name), types: data.types.map(t=>t.type.name), caught:false, is_legendary:false };
      // fetch species to get legendary flag
      const species = await (await fetch(data.species.url)).json();
      pokedex[id].is_legendary = !!species.is_legendary;
      save();
    }catch(e){ setToast('Erro ao carregar Pokémon'); return; }
  }

  const p = pokedex[id];
  modalBody.innerHTML = `<h3>${p.name} <small style="color:#666">#${id}</small></h3>
    <div class="poke-types">${(p.types||[]).map(t=>`<span class="badge">${t}</span>`).join('')}</div>
    <div style="margin-top:8px">${p.is_legendary?'<strong>Este é lendário</strong>':''}</div>`;
  modal.setAttribute('aria-hidden','false');
}

async function populateTypeFilter(){
  try{
    const res = await fetch(`${API_BASE}/type`);
    const data = await res.json();
    const types = data.results.map(r=>r.name).filter(n=>n!=='unknown' && n!=='shadow');
    types.forEach(t=>{
      const opt = document.createElement('option'); opt.value = t; opt.textContent = capitalize(t); typeFilter.appendChild(opt);
    });
  }catch(e){ /* ignore */ }
}

async function encounterRandom(){
  // prevent concurrent encounter fetches
  if(isFetchingEncounter) return;
  isFetchingEncounter = true;
  // pick a random id within allCount
  const id = Math.floor(Math.random()*allCount)+1;
  try{
    const data = await fetchPokemon(id);
    // shiny chance: 1 in 300
    const isShinyRoll = Math.floor(Math.random() * 300) === 0;
    const hasShinySprite = data.sprites && data.sprites.front_shiny;
    const isShiny = isShinyRoll && !!hasShinySprite;
    const sprite = isShiny ? data.sprites.front_shiny : data.sprites.front_default;
    // try to detect legendary status from species (best-effort)
    let isLegendary = false;
    try{ const sres = await fetch(data.species.url); const s = await sres.json(); isLegendary = !!s.is_legendary; }catch(e){}
    currentEncounter = { id: data.id, name: capitalize(data.name), sprite, types: data.types.map(t=>t.type.name), shiny: !!isShiny, is_legendary: isLegendary };
    if(isShiny){ setToast(`${capitalize(data.name)} is shiny! ✨`, 3000); }
    renderEncounter();
    // show shiny visual if present
    if(isShiny){
      // if it's a shiny legendary, give a special note
      if(currentEncounter.is_legendary){ setToast(`${currentEncounter.name} é um Lendário Shiny — captura garantida! ✨`, 3200); }
      try{
        const imgEl = pokeImage;
        if(imgEl){ imgEl.classList.add('shiny-glow'); setTimeout(()=>imgEl.classList.remove('shiny-glow'),1400); }
        // create confetti pieces inside the poke-img-wrapper
        const wrapper = document.querySelector('.poke-img-wrapper');
        if(wrapper){
          for(let i=0;i<10;i++){
            const pc = document.createElement('div'); pc.className = 'confetti-piece';
            pc.style.left = (20 + Math.random()*120) + 'px';
            pc.style.background = ['#ffd700','#ff6b6b','#6bc1ff','#a78bfa','#5eead4'][Math.floor(Math.random()*5)];
            wrapper.appendChild(pc);
            setTimeout(()=>pc.remove(),1400 + Math.random()*300);
          }
        }
      }catch(e){}
    }
  }catch(e){ console.error('encounterRandom error', e); setToast('Erro ao encontrar Pokémon'); }
  finally{ isFetchingEncounter = false; }
}

function renderEncounter(){
  if(!currentEncounter){
    // clear UI when there is no encounter
    if(pokeImage) { pokeImage.src = ''; pokeImage.style.display = 'none'; }
    if(pokeName) pokeName.textContent = '—';
    if(pokeId) pokeId.textContent = '#—';
    if(pokeTypes) pokeTypes.innerHTML = '';
    // disable capture button and hide pokeball
    if(btnCatch) btnCatch.disabled = true;
    if(pokeballEl) pokeballEl.style.display = 'none';
    return;
  }
  pokeImage.src = currentEncounter.sprite || '';
  pokeImage.style.display = currentEncounter.sprite ? 'block' : 'none';
  pokeName.textContent = currentEncounter.name || '—';
  pokeId.textContent = `#${currentEncounter.id}`;
  pokeTypes.innerHTML = (currentEncounter.types||[]).map(t=>`<span class="badge">${t}</span>`).join('');
  // enable capture button and show pokeball visual
  if(btnCatch) btnCatch.disabled = false;
  if(pokeballEl) pokeballEl.style.display = '';
}

async function fetchPokemon(idOrName){
  const res = await fetch(`${API_BASE}/pokemon/${idOrName}`);
  if(!res.ok) throw new Error('fetch');
  return res.json();
}

function tryCatch(){
  if(isProcessing) return; // prevent double attempts
  if(!currentEncounter) return setToast('Nenhum Pokémon encontrado');
  startProcessing();

  // determine ball and chance
  const ball = (ballSelect && ballSelect.value) || 'pokeball';
  const ballBonus = { pokeball:1.0, greatball:1.5, ultraball:2.2 }[ball] || 1.0;
  const base = 0.35; // base chance
  // if the current encounter is a shiny legendary, capture is guaranteed
  if(currentEncounter && currentEncounter.shiny && currentEncounter.is_legendary){
    var chance = 1.0;
  } else {
    var chance = Math.min(0.98, base * ballBonus + (pokedex[currentEncounter.id] && pokedex[currentEncounter.id].caught ? -0.1 : 0));
  }

  // consume ball (pokeball = -1 means infinite)
  if(ball !== 'pokeball'){
  if((inventory[ball]||0) <= 0){ setToast('Sem bolas desse tipo!'); stopProcessing(); return; }
    inventory[ball] = Math.max(0,(inventory[ball]||0)-1);
    saveInventory();
    // pulse the specific count briefly
    const elCount = el(ball === 'greatball' ? 'count-greatball' : 'count-ultraball');
    if(elCount){ elCount.classList.add('pulse'); setTimeout(()=>elCount.classList.remove('pulse'),450); }
  }

  // keep pokeball visible but do not animate
  if(pokeballEl){ pokeballEl.style.opacity = ''; }

  // resolve after animation
  setTimeout(()=>{
    try{
      const success = Math.random() < chance;
      if(success){
      // simplified capture flow: small pokeball animation then finalize (safer)
      const id = currentEncounter.id;
      try{
  // no capture animation on pokeball (static)
  if(pokeballEl){ /* intentionally static */ }
        // finalize after short delay to let the throw animation settle
        setTimeout(()=>{
          // finalize capture data
          pokedex[id] = pokedex[id] || { id, name: currentEncounter.name, types: currentEncounter.types, caught:false, is_legendary:false, sprite: currentEncounter.sprite, capturedAt: null, shiny: false };
          const firstCapture = !pokedex[id].caught;
          pokedex[id].caught = true;
          pokedex[id].sprite = pokedex[id].sprite || currentEncounter.sprite;
          if(!pokedex[id].capturedAt) pokedex[id].capturedAt = (new Date()).toISOString();
          // persist and update UI
          save(); renderPokedex(); updateStats();
          setToast(`${currentEncounter.name} capturado!`);
          currentEncounter = null; renderEncounter();
          if(firstCapture){
            captureCounter = (captureCounter||0) + 1;
            if(captureCounter % 10 === 0){ inventory.greatball = (inventory.greatball||0) + 1; setToast(`Bonus: you gained 1 Great Ball!`); }
            if(captureCounter % 100 === 0){ inventory.ultraball = (inventory.ultraball||0) + 1; setToast(`Big bonus: you gained 1 Ultra Ball!`); }
            saveInventory();
          }
            // lightweight confetti: create a few pieces and auto-clean
            try{
              const wrapper = document.querySelector('.poke-img-wrapper');
              if(wrapper){
                const colors = ['#ffd700','#ff6b6b','#6bc1ff','#a78bfa','#5eead4'];
                for(let i=0;i<12;i++){
                  const pc = document.createElement('div'); pc.className = 'confetti-piece';
                  pc.style.left = (20 + Math.random()*120) + 'px';
                  pc.style.background = colors[i % colors.length];
                  wrapper.appendChild(pc);
                  setTimeout(()=>pc.remove(), 1400 + Math.random()*200);
                }
              }
            }catch(e){}
          if(pokeballEl) { /* nothing to remove */ }
          // continue: clear processing and immediately show a new encounter (small delay so DOM can repaint)
          setTimeout(()=>{ stopProcessing(); encounterRandom(); }, 120);
        }, 420);
      }catch(e){
        // fallback: finalize immediately
        pokedex[id] = pokedex[id] || { id, name: currentEncounter.name, types: currentEncounter.types, caught:false, is_legendary:false, sprite: currentEncounter.sprite, capturedAt: null, shiny: false };
        const firstCapture = !pokedex[id].caught;
        pokedex[id].caught = true;
        pokedex[id].sprite = pokedex[id].sprite || currentEncounter.sprite;
        if(!pokedex[id].capturedAt) pokedex[id].capturedAt = (new Date()).toISOString();
  save(); renderPokedex(); updateStats();
        setToast(`${currentEncounter.name} capturado!`);
        currentEncounter = null; renderEncounter();
        if(firstCapture){ captureCounter = (captureCounter||0) + 1; if(captureCounter % 10 === 0){ inventory.greatball = (inventory.greatball||0) + 1; setToast(`Bonus: you gained 1 Great Ball!`); } if(captureCounter % 100 === 0){ inventory.ultraball = (inventory.ultraball||0) + 1; setToast(`Big bonus: you gained 1 Ultra Ball!`); } saveInventory(); }
  // immediate follow-up encounter after fallback finalize
  setTimeout(()=>{ stopProcessing(); encounterRandom(); }, 120);
      }
      } else {
  // failed capture -> pokemon escapes after a short flee animation
      const name = capitalize(currentEncounter.name || 'Pokémon');
      // cleanup throw class immediately
  if(pokeballEl) { /* nothing to cleanup */ }
      if(pokeImage){
        // play flee animation on the image
        pokeImage.classList.remove('flee'); void pokeImage.offsetWidth; pokeImage.classList.add('flee');
        // after animation, show message, clear encounter and immediately replace with a new encounter
        setTimeout(()=>{
          setToast(`${name} escaped after the Pokéball broke!`);
          currentEncounter = null; renderEncounter();
          pokeImage.classList.remove('flee');
          // allow actions and immediately show a new encounter
          stopProcessing();
          encounterRandom();
        }, 700);
      } else {
        setToast('A Pokébola falhou!');
        currentEncounter = null; renderEncounter();
  // allow actions and immediately show a new encounter
  stopProcessing(); encounterRandom();
      }
      }
      }catch(err){
        console.error('tryCatch resolution error', err);
        // ensure we don't stay blocked
        stopProcessing();
        try{ renderEncounter(); }catch(e){}
      }
  }, 600);
}

function runAway(){
  if(isProcessing) return;
  if(!currentEncounter) return setToast('Nenhum Pokémon encontrado');
  startProcessing();
  const name = capitalize(currentEncounter.name || 'Pokémon');
  if(pokeImage){
    pokeImage.classList.remove('flee'); void pokeImage.offsetWidth; pokeImage.classList.add('flee');
    setTimeout(()=>{
      setToast(`${name} fled the battle`);
      currentEncounter = null; renderEncounter();
      pokeImage.classList.remove('flee');
      // allow processing flag to be cleared and auto encounter
  setTimeout(()=>{ stopProcessing(); encounterRandom(); }, 300);
    }, 700);
  } else {
    setToast(`${name} fled the battle`);
    currentEncounter = null; renderEncounter();
    stopProcessing();
    setTimeout(()=>{ encounterRandom(); }, 300);
  }
}

function exportPokedex(){
  const data = JSON.stringify(pokedex,null,2);
  const blob = new Blob([data],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'pokedex.json'; a.click(); URL.revokeObjectURL(url);
}

function importPokedex(){
  const input = document.createElement('input'); input.type='file'; input.accept='application/json';
  input.addEventListener('change', (e)=>{
    const f = e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{ const data = JSON.parse(reader.result); pokedex = data; save(); renderPokedex(); setToast('Pokédex importada'); }catch(e){ setToast('Arquivo inválido'); }
    };
    reader.readAsText(f);
  });
  input.click();
}

function resetPokedex(){ if(confirm('Resetar Pokédex? Esta ação não pode ser desfeita.')){ pokedex = {}; save(); renderPokedex(); setToast('Pokédex resetada'); }}

// small util
function capitalize(s){ return s.charAt(0).toUpperCase()+s.slice(1); }
function debounce(fn,ms=200){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; }

// start
init();
