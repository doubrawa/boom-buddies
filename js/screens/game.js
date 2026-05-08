import {
  charCanvas, boxCanvas, pillarCanvas, heartCanvas, pupCanvas,
  bombCanvas, exCenterCanvas, exArmCanvas,
  PUPS, CHARS,
} from '../sprites.js';
import { createEngine } from '../game/engine.js';
import { TILE, FIELD_PRESETS } from '../game/field.js';
import { SCHEME_LABEL } from '../game/input.js';
import { HOT_THRESHOLD } from '../game/bombs.js';

const TS = 42;                 // tile pixel size — must match CSS .board --ts
const PLAYER_PX = 38;          // player sprite display size
const BOMB_PX = 32;            // bomb sprite display size
const EX_PX = 38;              // explosion piece display size

let engine = null;
let timerHandle = null;

export function render(app, navigate, state){
  const section = document.createElement('section');
  section.className = 'screen gp active';
  section.innerHTML = `
    <div class="gp">
      <div class="gpcol left" id="leftHud"></div>

      <div class="stage">
        <div class="topbar">
          <div class="round-pill">ROUND&nbsp;1/${state.rounds}</div>
          <div class="timer" id="timer">${formatTime(state.timeLimit || 150)}</div>
          <div class="live">● LIVE</div>
          <button class="end-round" data-action="end-round">END ROUND ▶</button>
        </div>
        <div class="board" id="board"></div>
        <div class="pup-row">
          <h4><span class="dot"></span>POWER-UPS · ALL 12 PICK-UPS</h4>
          <div class="pup-grid" id="pupGrid"></div>
        </div>
      </div>

      <div class="gpcol right" id="rightHud"></div>
    </div>
  `;
  app.appendChild(section);

  /* Spin up the engine. */
  const view = {};   // owns DOM refs we update each frame
  engine = createEngine(state, {
    onEvents: (events) => handleEvents(events, view),
    onRender: () => {
      renderPlayers(view, engine.players);
      renderBombs(view, engine.bombs);
      renderExplosions(view, engine.explosions);
    },
  });

  const boardEl = section.querySelector('#board');
  buildBoard(boardEl, engine.field, view);
  buildPowerupRow(section.querySelector('#pupGrid'));

  /* HUD. */
  const lh = section.querySelector('#leftHud');
  const rh = section.querySelector('#rightHud');
  const half = Math.ceil(engine.players.length / 2);
  view.hudByIdx = new Map();
  engine.players.slice(0, half).forEach(p => { const c = buildHudCard(p); view.hudByIdx.set(p.idx, c); lh.appendChild(c); });
  engine.players.slice(half).forEach(p => { const c = buildHudCard(p); view.hudByIdx.set(p.idx, c); rh.appendChild(c); });

  const pupRow = section.querySelector('.pup-row');
  pupRow.style.width = (engine.field.width * TS + 8) + 'px';

  /* Timer. */
  let secs = state.timeLimit || 150;
  const timerEl = section.querySelector('#timer');
  if(secs > 0){
    timerHandle = setInterval(() => {
      secs = Math.max(0, secs - 1);
      timerEl.textContent = formatTime(secs);
      if(secs === 0) stopTimer();
    }, 1000);
  }

  section.querySelector('[data-action="end-round"]').addEventListener('click', () => {
    teardown();
    navigate('roundend');
  });

  engine.start();
}

export function teardown(){
  stopTimer();
  if(engine){ engine.stop(); engine = null; }
}

function stopTimer(){ if(timerHandle){ clearInterval(timerHandle); timerHandle = null; } }
function formatTime(s){ const m = Math.floor(s/60), ss = String(s%60).padStart(2,'0'); return `${m}:${ss}`; }

/* ============ BOARD CONSTRUCTION ============ */

function buildBoard(boardEl, field, view){
  boardEl.style.gridTemplateColumns = `repeat(${field.width}, ${TS}px)`;
  boardEl.style.gridTemplateRows    = `repeat(${field.height}, ${TS}px)`;
  boardEl.style.position = 'relative';

  /* Keep an array of tile divs so we can remove box sprites on destruction. */
  view.tileEls = new Array(field.width * field.height);

  for(let y = 0; y < field.height; y++){
    for(let x = 0; x < field.width; x++){
      const t = document.createElement('div');
      t.className = 'tile';
      const v = field.at(x, y);
      if(v === TILE.PILLAR){
        t.appendChild(pillarCanvas());
      } else {
        t.classList.add('floor');
        if((x + y) % 2) t.classList.add('b');
        if(v === TILE.BOX) t.appendChild(boxCanvas());
      }
      boardEl.appendChild(t);
      view.tileEls[y * field.width + x] = t;
    }
  }

  /* Three absolute-positioned layers stacked over the grid. */
  view.bombLayer      = makeLayer(field, 3);
  view.playerLayer    = makeLayer(field, 5);
  view.explosionLayer = makeLayer(field, 7);
  boardEl.appendChild(view.bombLayer);
  boardEl.appendChild(view.playerLayer);
  boardEl.appendChild(view.explosionLayer);

  view.fieldWidth = field.width;
}

function makeLayer(field, z){
  const el = document.createElement('div');
  el.style.cssText = `
    position:absolute; left:4px; top:4px;
    width:${field.width * TS}px; height:${field.height * TS}px;
    pointer-events:none; z-index:${z};
  `;
  return el;
}

/* ============ PER-FRAME RENDERING ============ */

function renderPlayers(view, players){
  if(!view.playerSprites){
    view.playerSprites = new Map();
    for(const p of players){
      const div = makeEntityDiv(PLAYER_PX);
      const cv = charCanvas(p.charId);
      cv.style.width = PLAYER_PX + 'px';
      cv.style.height = PLAYER_PX + 'px';
      div.appendChild(cv);
      view.playerLayer.appendChild(div);
      view.playerSprites.set(p.idx, div);
    }
  }
  for(const p of players){
    const div = view.playerSprites.get(p.idx);
    if(!div) continue;
    div.style.transform = `translate(${(p.x * TS).toFixed(2)}px, ${(p.y * TS).toFixed(2)}px)`;
    if(!p.alive){
      div.style.filter = 'grayscale(.7) opacity(.5)';
      div.style.zIndex = '1';
    }
  }
}

function renderBombs(view, bombs){
  if(!view.bombSprites) view.bombSprites = new Map();
  /* Add divs for new bombs, update existing. */
  const seen = new Set();
  for(const b of bombs){
    seen.add(b.id);
    let entry = view.bombSprites.get(b.id);
    if(!entry){
      const div = makeEntityDiv(BOMB_PX);
      div.className = 'bomb-sprite breathe';
      const cv = bombCanvas(false);
      cv.style.width = BOMB_PX + 'px';
      cv.style.height = BOMB_PX + 'px';
      div.appendChild(cv);
      view.bombLayer.appendChild(div);
      entry = { div, hot: false };
      view.bombSprites.set(b.id, entry);
    }
    /* Position at the center of its tile. */
    entry.div.style.transform = `translate(${((b.x + 0.5) * TS).toFixed(2)}px, ${((b.y + 0.5) * TS).toFixed(2)}px)`;
    /* Switch to hot sprite + animation in the last second. */
    const shouldBeHot = b.fuse <= HOT_THRESHOLD;
    if(shouldBeHot && !entry.hot){
      entry.hot = true;
      entry.div.className = 'bomb-sprite hot-pulse';
      entry.div.innerHTML = '';
      const cv = bombCanvas(true);
      cv.style.width = BOMB_PX + 'px';
      cv.style.height = BOMB_PX + 'px';
      entry.div.appendChild(cv);
    }
  }
  /* Reap bombs that no longer exist (detonated). */
  for(const [id, entry] of view.bombSprites){
    if(!seen.has(id)){
      entry.div.remove();
      view.bombSprites.delete(id);
    }
  }
}

function renderExplosions(view, explosions){
  if(!view.explosionSprites) view.explosionSprites = new Map();
  const seen = new Set();
  for(const e of explosions){
    seen.add(e);
    let entry = view.explosionSprites.get(e);
    if(!entry){
      const segs = [];
      for(const s of e.segments){
        const div = makeEntityDiv(EX_PX);
        div.className = 'pulse-fast';
        div.style.transform = `translate(${((s.x + 0.5) * TS).toFixed(2)}px, ${((s.y + 0.5) * TS).toFixed(2)}px)`;
        let cv;
        if(s.kind === 'center') cv = exCenterCanvas();
        else if(s.kind === 'arm-h') cv = exArmCanvas(0);
        else cv = exArmCanvas(90);
        cv.style.width = EX_PX + 'px';
        cv.style.height = EX_PX + 'px';
        div.appendChild(cv);
        view.explosionLayer.appendChild(div);
        segs.push(div);
      }
      entry = { segs };
      view.explosionSprites.set(e, entry);
    }
    /* Fade with remaining ttl. */
    const opacity = Math.max(0, Math.min(1, e.ttl / 0.45));
    for(const d of entry.segs) d.style.opacity = opacity.toFixed(2);
  }
  /* Remove faded explosions. */
  for(const [e, entry] of view.explosionSprites){
    if(!seen.has(e)){
      for(const d of entry.segs) d.remove();
      view.explosionSprites.delete(e);
    }
  }
}

function makeEntityDiv(px){
  const div = document.createElement('div');
  div.style.cssText = `
    position:absolute;
    width:${px}px; height:${px}px;
    margin-left:${-px/2}px; margin-top:${-px/2}px;
    will-change: transform;
  `;
  return div;
}

/* ============ EVENT HANDLERS ============ */

function handleEvents(events, view){
  for(const ev of events){
    if(ev.type === 'boxBroken'){
      const t = view.tileEls[ev.y * view.fieldWidth + ev.x];
      if(t){
        /* Remove all children (the box canvas).  Floor classes stay. */
        while(t.firstChild) t.removeChild(t.firstChild);
      }
    } else if(ev.type === 'playerKilled'){
      const card = view.hudByIdx.get(ev.idx);
      if(card) card.classList.add('dead');
    }
  }
}

/* ============ HUD + POWER-UP ROW ============ */

function buildPowerupRow(grid){
  Object.keys(PUPS).forEach(id => {
    const cell = document.createElement('div');
    cell.className = 'pup-cell';
    cell.appendChild(pupCanvas(id));
    const text = document.createElement('span');
    text.innerHTML = `<span class="nm">${PUPS[id].nm}</span><span class="ds">${PUPS[id].ds}</span>`;
    cell.appendChild(text);
    grid.appendChild(cell);
  });
}

function buildHudCard(p){
  const card = document.createElement('div');
  card.className = 'pcard';
  card.dataset.idx = p.idx;
  const ctrlLabel = p.scheme ? SCHEME_LABEL[p.scheme] : (p.type === 'cpu' ? 'CPU' : '—');
  card.innerHTML = `
    <div class="row1" data-row1></div>
    <div class="hearts" data-hearts></div>
    <div class="ctrl-mini" style="font-size:7px;color:var(--mid);margin-top:6px">${ctrlLabel}</div>
  `;
  const row1 = card.querySelector('[data-row1]');
  row1.appendChild(charCanvas(p.charId));
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || nameFor(p);
  const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = '0';
  row1.appendChild(nm); row1.appendChild(sc);
  const hearts = card.querySelector('[data-hearts]');
  for(let i = 0; i < 3; i++) hearts.appendChild(heartCanvas(false));
  return card;
}

function nameFor(p){
  return (CHARS[p.charId] && p.charId.toUpperCase()) || ('P' + (p.idx + 1));
}
