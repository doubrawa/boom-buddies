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
let endTransitionHandle = null;

const ROUND_END_DELAY_MS = 1500;   // beat for the killing explosion to fade

export function render(ctx){
  const { app, navigate, lobby, match } = ctx;
  const section = document.createElement('section');
  section.className = 'screen gp active';
  const initialSecs = lobby.timeLimit || 0;
  section.innerHTML = `
    <div class="gp">
      <div class="gpcol left" id="leftHud"></div>

      <div class="stage">
        <div class="topbar">
          <div class="round-pill">ROUND&nbsp;${match.current}/${match.rounds}</div>
          <div class="timer" id="timer">${initialSecs > 0 ? formatTime(initialSecs) : '∞'}</div>
          <div class="live">● LIVE</div>
          <button class="end-round" data-action="end-round">FORFEIT ▶</button>
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

  /* Spin up the engine.  It owns the round timer; we mirror it visually below. */
  const view = {};
  engine = createEngine(lobby, {
    onEvents: (events) => handleEvents(events, view),
    onRender: () => {
      renderPlayers(view, engine.players);
      renderBombs(view, engine.bombs);
      renderExplosions(view, engine.explosions);
    },
    onRoundEnd: (result) => scheduleRoundEnd(ctx, result),
  });

  const boardEl = section.querySelector('#board');
  buildBoard(boardEl, engine.field, view);
  buildPowerupRow(section.querySelector('#pupGrid'));

  /* HUD reflects the current match roster. */
  const lh = section.querySelector('#leftHud');
  const rh = section.querySelector('#rightHud');
  const half = Math.ceil(engine.players.length / 2);
  view.hudByIdx = new Map();
  engine.players.slice(0, half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); lh.appendChild(c); });
  engine.players.slice(half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); rh.appendChild(c); });

  const pupRow = section.querySelector('.pup-row');
  pupRow.style.width = (engine.field.width * TS + 8) + 'px';

  /* Visual timer mirrors engine.elapsed against lobby.timeLimit. */
  const timerEl = section.querySelector('#timer');
  if(initialSecs > 0){
    timerHandle = setInterval(() => {
      const remaining = Math.max(0, Math.ceil(initialSecs - engine.elapsed));
      timerEl.textContent = formatTime(remaining);
      if(remaining <= 0) stopTimer();
    }, 250);
  }

  /* Forfeit button: produce a draw result for this round. */
  section.querySelector('[data-action="end-round"]').addEventListener('click', () => {
    if(endTransitionHandle != null) return;
    const result = {
      winnerIdx: null,
      durationSec: engine ? engine.elapsed : 0,
      kos: new Map(),
      reason: 'forfeit',
    };
    scheduleRoundEnd(ctx, result);
  });

  engine.start();
}

function scheduleRoundEnd(ctx, result){
  if(endTransitionHandle != null) return;   // already scheduled
  stopTimer();
  endTransitionHandle = setTimeout(() => {
    endTransitionHandle = null;
    ctx.recordRound(result);
    ctx.navigate('roundend');
  }, ROUND_END_DELAY_MS);
}

export function teardown(){
  stopTimer();
  if(endTransitionHandle != null){ clearTimeout(endTransitionHandle); endTransitionHandle = null; }
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
  const seen = new Set();
  for(const b of bombs){
    seen.add(b.id);
    let entry = view.bombSprites.get(b.id);
    if(!entry){
      /* Two-div trick: outer holds the position transform, inner runs the
         CSS animation transform.  If both lived on one element the keyframe
         transform would override the inline one and the bomb would snap to (0,0). */
      const wrap = makePosWrapper();
      const inner = makeAnimatedSprite('bomb-sprite breathe', BOMB_PX);
      const cv = bombCanvas(false);
      cv.style.width = BOMB_PX + 'px';
      cv.style.height = BOMB_PX + 'px';
      inner.appendChild(cv);
      wrap.appendChild(inner);
      view.bombLayer.appendChild(wrap);
      entry = { wrap, inner, hot: false };
      view.bombSprites.set(b.id, entry);
    }
    entry.wrap.style.transform = `translate(${((b.x + 0.5) * TS).toFixed(2)}px, ${((b.y + 0.5) * TS).toFixed(2)}px)`;
    const shouldBeHot = b.fuse <= HOT_THRESHOLD;
    if(shouldBeHot && !entry.hot){
      entry.hot = true;
      entry.inner.className = 'bomb-sprite hot-pulse';
      entry.inner.innerHTML = '';
      const cv = bombCanvas(true);
      cv.style.width = BOMB_PX + 'px';
      cv.style.height = BOMB_PX + 'px';
      entry.inner.appendChild(cv);
    }
  }
  for(const [id, entry] of view.bombSprites){
    if(!seen.has(id)){
      entry.wrap.remove();
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
      const wraps = [];
      for(const s of e.segments){
        const wrap = makePosWrapper();
        const inner = makeAnimatedSprite('pulse-fast', EX_PX);
        wrap.style.transform = `translate(${((s.x + 0.5) * TS).toFixed(2)}px, ${((s.y + 0.5) * TS).toFixed(2)}px)`;
        let cv;
        if(s.kind === 'center') cv = exCenterCanvas();
        else if(s.kind === 'arm-h') cv = exArmCanvas(0);
        else cv = exArmCanvas(90);
        cv.style.width = EX_PX + 'px';
        cv.style.height = EX_PX + 'px';
        inner.appendChild(cv);
        wrap.appendChild(inner);
        view.explosionLayer.appendChild(wrap);
        wraps.push(wrap);
      }
      entry = { wraps };
      view.explosionSprites.set(e, entry);
    }
    const opacity = Math.max(0, Math.min(1, e.ttl / 0.45));
    for(const w of entry.wraps) w.style.opacity = opacity.toFixed(2);
  }
  for(const [e, entry] of view.explosionSprites){
    if(!seen.has(e)){
      for(const w of entry.wraps) w.remove();
      view.explosionSprites.delete(e);
    }
  }
}

/* Outer position wrapper — owns the translate(x,y) for placement.
   Has zero size; children are absolutely positioned within. */
function makePosWrapper(){
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute; left:0; top:0; will-change: transform;';
  return div;
}

/* Inner sprite — owns the CSS animation that applies its own transform.
   Centered around the wrapper origin via negative margins. */
function makeAnimatedSprite(animClass, px){
  const div = document.createElement('div');
  div.className = animClass;
  div.style.cssText = `
    position:absolute;
    width:${px}px; height:${px}px;
    margin-left:${-px/2}px; margin-top:${-px/2}px;
  `;
  return div;
}

/* Player sprite has no CSS animation, so position transform stays put. */
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

function buildHudCard(p, match){
  const card = document.createElement('div');
  card.className = 'pcard';
  card.dataset.idx = p.idx;
  /* Cumulative wins from earlier rounds, if any. */
  const matchPlayer = match?.players?.find(x => x.idx === p.idx);
  const wins = matchPlayer?.score || 0;
  const ctrlLabel = p.scheme ? SCHEME_LABEL[p.scheme] : (p.type === 'cpu' ? 'CPU' : '—');
  card.innerHTML = `
    <div class="row1" data-row1></div>
    <div class="hearts" data-hearts></div>
    <div class="ctrl-mini" style="font-size:7px;color:var(--mid);margin-top:6px">${ctrlLabel}</div>
  `;
  const row1 = card.querySelector('[data-row1]');
  row1.appendChild(charCanvas(p.charId));
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || nameFor(p);
  const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = wins > 0 ? `${wins}W` : '—';
  row1.appendChild(nm); row1.appendChild(sc);
  const hearts = card.querySelector('[data-hearts]');
  for(let i = 0; i < 3; i++) hearts.appendChild(heartCanvas(false));
  return card;
}

function nameFor(p){
  return (CHARS[p.charId] && p.charId.toUpperCase()) || ('P' + (p.idx + 1));
}
