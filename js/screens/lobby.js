import { charSvg, icoSvg, CHAR_IDS, CHARS } from '../sprites.js';

const FIELD_SIZES = [
  { id:'small',  w:11, h:9,  label:'Cozy',    meta:['~2 min rounds', '2–3 buddies'] },
  { id:'medium', w:15, h:13, label:'Classic', meta:['~3 min rounds', '4–6 buddies'] },
  { id:'large',  w:19, h:17, label:'Chaos',   meta:['~5 min rounds', '6–8 buddies'] },
];

const SCHEME_KEYS = {
  wasd:   { move: 'WASD',  bomb: '␣' },
  arrows: { move: '↑↓←→', bomb: '⏎' },
  ijkl:   { move: 'IJKL',  bomb: 'U' },
  numpad: { move: '8456',  bomb: '0' },
};

/* Slot-index → preferred control scheme for human players. */
const HUMAN_SCHEME_ORDER = ['wasd', 'arrows', 'ijkl', 'numpad'];

const DEFAULT_NAMES = ['Mochi', 'Bubble', 'Biscuit', 'Pickle', 'Plum', 'Sage', 'Daisy', 'Cocoa'];
const DEFAULT_MODES = ['human', 'human', 'human', 'human', 'cpu', 'cpu', 'off', 'off'];

export function defaultLobbyState(){
  return {
    fieldSize: 'medium',
    rounds: 3,
    timeLimit: 150,
    goodieFreq: 1,                  // 0=sparse 1=normal 2=generous
    players: CHAR_IDS.map((id, i) => ({
      id,
      name: DEFAULT_NAMES[i] || CHARS[id].name,
      mode: DEFAULT_MODES[i] || 'off',
    })),
  };
}

export function render(ctx){
  const { app, navigate, lobby: state } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';

  section.innerHTML = `
    <div class="lobby">
      <div class="topbar-nav">
        <button class="back" data-action="back">◀ Back</button>
        <div></div>
      </div>
      <h2>Game Setup</h2>
      <p class="lead">Choose a field · Add up to 8 buddies · Set the rules</p>

      <div class="panel">
        <div class="panel-h"><span class="pip"></span>Field Size <span class="ct">3 layouts</span></div>
        <div class="fields" id="fields"></div>
      </div>

      <div class="panel">
        <div class="panel-h"><span class="pip" style="background:var(--mint)"></span>Buddies <span class="ct" data-roster-count></span></div>
        <div class="pgrid" id="pgrid"></div>
      </div>

      <div class="twocol">
        <div class="panel">
          <div class="panel-h"><span class="pip" style="background:var(--peach)"></span>Goodie Drops</div>
          <div class="opt-lbl">How often crates drop power-ups</div>
          <div class="slider-wrap">
            <div class="slider" data-slider="goodies"><div class="fill" style="width:${['33%','62%','85%'][state.goodieFreq]}"></div></div>
            <div class="slider-ticks"><span>Sparse</span><span>Normal</span><span>Generous</span></div>
          </div>
          <div data-goodie-readout style="font-size:12px;color:var(--mid);margin-top:14px;font-weight:700"></div>
        </div>
        <div class="panel">
          <div class="panel-h"><span class="pip" style="background:var(--lav)"></span>Round Rules</div>
          <div class="opt-lbl">Best of</div>
          <div class="seg-row" data-seg="rounds">
            <span data-val="1" class="${state.rounds===1?'on':''}">1</span>
            <span data-val="3" class="${state.rounds===3?'on':''}">3</span>
            <span data-val="5" class="${state.rounds===5?'on':''}">5</span>
            <span data-val="7" class="${state.rounds===7?'on':''}">7</span>
          </div>
          <div class="opt-lbl">Time limit</div>
          <div class="seg-row" data-seg="time">
            <span data-val="90"  class="${state.timeLimit===90?'on':''}">1:30</span>
            <span data-val="150" class="${state.timeLimit===150?'on':''}">2:30</span>
            <span data-val="210" class="${state.timeLimit===210?'on':''}">3:30</span>
            <span data-val="0"   class="${state.timeLimit===0?'on':''}">∞</span>
          </div>
        </div>
      </div>

      <button class="start-btn" data-action="start">
        <span class="ic" data-spr="ico-play"></span>
        Start the chaos!
      </button>
    </div>
  `;
  app.appendChild(section);

  /* Field cards. */
  buildFields(section.querySelector('#fields'), state);

  /* Buddy slots. */
  buildSlots(section.querySelector('#pgrid'), state);
  updateRosterCount(section, state);

  /* Goodie readout. */
  updateGoodieReadout(section, state);

  /* Slot icons. */
  section.querySelectorAll('[data-spr="ico-play"]').forEach(el => {
    el.appendChild(icoSvg('play', 20));
  });

  /* Rounds + time-limit segments. */
  section.querySelectorAll('[data-seg]').forEach(g => {
    g.querySelectorAll('span').forEach(s => {
      s.addEventListener('click', () => {
        g.querySelectorAll('span').forEach(x => x.classList.remove('on'));
        s.classList.add('on');
        const key = g.getAttribute('data-seg');
        const val = parseInt(s.getAttribute('data-val'), 10);
        if(key === 'rounds') state.rounds = val;
        if(key === 'time')   state.timeLimit = val;
      });
    });
  });

  /* Goodie slider. */
  const slider = section.querySelector('[data-slider="goodies"]');
  slider.addEventListener('click', (e) => {
    const r = slider.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const step = x < 0.34 ? 0 : (x < 0.67 ? 1 : 2);
    state.goodieFreq = step;
    slider.querySelector('.fill').style.width = ['33%','62%','85%'][step];
    updateGoodieReadout(section, state);
  });

  /* Nav. */
  section.querySelector('[data-action="back"]').addEventListener('click', () => navigate('title'));
  section.querySelector('[data-action="start"]').addEventListener('click', () => {
    if(activeCount(state) < 1) return;
    navigate('game');
  });
}

function buildFields(host, state){
  host.innerHTML = '';
  for(const f of FIELD_SIZES){
    const card = document.createElement('div');
    card.className = 'field' + (state.fieldSize === f.id ? ' sel' : '');
    card.dataset.id = f.id;
    card.innerHTML = `
      <div class="head"><span class="name">${f.label}</span><span class="dim">${f.w} × ${f.h}</span></div>
      <div class="preview">${miniPreviewSvg(f.w, f.h)}</div>
      <div class="meta"><span>${f.meta[0]}</span><span>${f.meta[1]}</span></div>
      <span class="badge-sel">SELECTED</span>
    `;
    card.addEventListener('click', () => {
      host.querySelectorAll('.field').forEach(x => x.classList.remove('sel'));
      card.classList.add('sel');
      state.fieldSize = f.id;
    });
    host.appendChild(card);
  }
}

/* Lightweight inline SVG preview of a field — pillars, a few crates,
   and chibi dots in the corners. */
function miniPreviewSvg(w, h){
  const TS = 10;
  const W = w * TS, H = h * TS;
  let pillars = '';
  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      const isBorder = x === 0 || y === 0 || x === w-1 || y === h-1;
      const isPillar = x % 2 === 0 && y % 2 === 0;
      if(isBorder || isPillar) pillars += `<rect x="${x*TS}" y="${y*TS}" width="${TS}" height="${TS}" fill="#9c8db8" stroke="#5b4d7a" stroke-width=".8"/>`;
    }
  }
  /* Pseudo-random crate sprinkle. */
  let crates = '';
  for(let y = 1; y < h-1; y++){
    for(let x = 1; x < w-1; x++){
      if(x % 2 === 0 && y % 2 === 0) continue;
      if(((x*7 + y*3) % 5) >= 3) crates += `<rect x="${x*TS+1}" y="${y*TS+1}" width="${TS-2}" height="${TS-2}" rx="2" fill="#ffae6a" stroke="#2b2150" stroke-width=".6"/>`;
    }
  }
  const r = TS * 0.6;
  const corners = `
    <circle cx="${TS*1.5}" cy="${TS*1.5}" r="${r}" fill="#ff9dbf" stroke="#2b2150" stroke-width=".8"/>
    <circle cx="${(w-1.5)*TS}" cy="${TS*1.5}" r="${r}" fill="#a9d8ff" stroke="#2b2150" stroke-width=".8"/>
    <circle cx="${TS*1.5}" cy="${(h-1.5)*TS}" r="${r}" fill="#ffd76b" stroke="#2b2150" stroke-width=".8"/>
    <circle cx="${(w-1.5)*TS}" cy="${(h-1.5)*TS}" r="${r}" fill="#c5a8ed" stroke="#2b2150" stroke-width=".8"/>
  `;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><rect width="${W}" height="${H}" fill="#dff0d6"/>${pillars}${crates}${corners}</svg>`;
}

function buildSlots(host, state){
  host.innerHTML = '';
  state.players.forEach((p, i) => {
    const slot = document.createElement('div');
    slot.className = 'pslot ' + (p.mode === 'off' ? 'empty' : (p.mode === 'cpu' ? 'cpu' : ''));
    slot.dataset.idx = i;
    const scheme = humanSchemeFor(state, i);
    const ctrlInner = p.mode === 'human'
      ? `<span class="key">${SCHEME_KEYS[scheme].move}</span><span class="key">${SCHEME_KEYS[scheme].bomb}</span><span class="lbl">move + bomb</span>`
      : (p.mode === 'cpu' ? `<span class="lbl">A CPU buddy. We'll wire its brain in Etappe 6.</span>` : `<span class="lbl">tap a tab to add</span>`);
    const topLabel = p.mode === 'off' ? 'EMPTY' : (p.mode === 'cpu' ? 'CPU' : 'HUMAN');

    slot.innerHTML = `
      <div class="ptop"><span class="num">P${i+1}</span><span data-mode-label>${topLabel}</span></div>
      <div class="av">
        <span class="face" data-face></span>
        <input class="nm" value="${escapeHtml(p.name)}" maxlength="14"/>
      </div>
      <div class="ctrl" data-ctrl>${ctrlInner}</div>
      <div class="seg" data-pseg>
        <span data-mv="human" class="${p.mode==='human'?'on':''}">HUMAN</span>
        <span data-mv="cpu"   class="${p.mode==='cpu'?'on':''}">CPU</span>
        <span data-mv="off"   class="${p.mode==='off'?'on':''}">OFF</span>
      </div>
    `;
    host.appendChild(slot);

    /* Face SVG. */
    if(p.mode !== 'off') slot.querySelector('[data-face]').appendChild(charSvg(p.id, { w: 74, h: 74 }));

    /* Name input. */
    slot.querySelector('.nm').addEventListener('input', (e) => {
      state.players[i].name = e.target.value;
    });

    /* Mode segment.  When the mode changes we rebuild every slot so the
       control-scheme labels stay correct (each human takes the next free
       keyboard binding). */
    slot.querySelectorAll('[data-pseg] span').forEach(s => {
      s.addEventListener('click', () => {
        const mv = s.getAttribute('data-mv');
        state.players[i].mode = mv;
        buildSlots(host, state);
        const lobbyHost = host.closest('section');
        if(lobbyHost) updateRosterCount(lobbyHost, state);
      });
    });
  });
}

function humanSchemeFor(state, idx){
  let humanCount = 0;
  for(let i = 0; i <= idx; i++){
    if(state.players[i].mode === 'human'){
      if(i === idx) return HUMAN_SCHEME_ORDER[humanCount] || 'wasd';
      humanCount++;
    }
  }
  return 'wasd';
}

function activeCount(state){
  return state.players.filter(p => p.mode !== 'off').length;
}

function updateRosterCount(scope, state){
  const el = scope.querySelector?.('[data-roster-count]') || document.querySelector('[data-roster-count]');
  if(el) el.textContent = `${activeCount(state)}/8 active`;
}

function updateGoodieReadout(scope, state){
  const el = scope.querySelector('[data-goodie-readout]');
  if(!el) return;
  const labels = ['Sparse — about 1 in 6 crates carries a treat.', 'Normal — about 1 in 3 crates carries a treat.', 'Generous — about 1 in 2 crates carries a treat.'];
  el.innerHTML = `Currently: <b style="color:var(--ink)">${['Sparse','Normal','Generous'][state.goodieFreq]}</b> — ${labels[state.goodieFreq].split('—')[1].trim()}`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
