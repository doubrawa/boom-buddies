import {
  charSvg, bombSvg, pupSvg, icoSvg, crownSvg, heartSvg,
  blastCenterSvg, blastArmSvg,
  PUPS, ALL_PUP_IDS, CHARS,
} from '../sprites.js';
import { createEngine } from '../game/engine.js';
import { TILE } from '../game/field.js';
import { SCHEME_LABEL } from '../game/input.js';
import { HOT_THRESHOLD } from '../game/bombs.js';

const TS = 42;                 // tile size in px — matches CSS .board --ts
const PLAYER_SIZE = 40;        // sprite display size in px
const BOMB_SIZE = 36;
const BLAST_SIZE = 40;
const PICKUP_SIZE = 28;

let engine = null;
let timerHandle = null;
let endTransitionHandle = null;

const ROUND_END_DELAY_MS = 1500;

const SCHEME_KEY_LABEL = {
  wasd:   { move: 'WASD',  bomb: '␣' },
  arrows: { move: '↑↓←→', bomb: '⏎' },
  ijkl:   { move: 'IJKL',  bomb: 'U' },
  numpad: { move: '8456',  bomb: '0' },
};

export function render(ctx){
  const { app, navigate, lobby, match } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';
  const initialSecs = lobby.timeLimit || 0;

  section.innerHTML = `
    <div class="gp">
      <div class="gpcol left" id="leftHud"></div>

      <div class="stage">
        <div class="topbar">
          <div class="round-pill">Round ${match.current} / ${match.rounds}</div>
          <div class="timer"><span class="dot"></span><span data-timer>${initialSecs > 0 ? formatTime(initialSecs) : '∞'}</span></div>
          <div class="live-pill"><span class="blip"></span>LIVE</div>
          <button class="end-round" data-action="end-round">Forfeit ▶</button>
        </div>

        <div class="board" id="board"></div>

        <div class="pup-row">
          <h4><span class="pip"></span>Power-ups · all 12 pickups</h4>
          <div class="pup-grid" id="pupGrid"></div>
        </div>
      </div>

      <div class="gpcol right" id="rightHud"></div>
    </div>
  `;
  app.appendChild(section);

  /* Engine. */
  const view = {};
  engine = createEngine(lobby, {
    onEvents: (events) => handleEvents(events, view, engine),
    onRender: () => {
      renderPlayers(view, engine.players, engine.elapsed);
      renderBombs(view, engine.bombs);
      renderExplosions(view, engine.explosions);
      renderPickups(view, engine.pickups);
    },
    onRoundEnd: (result) => scheduleRoundEnd(ctx, result),
  });

  /* Build static board + layers. */
  const boardEl = section.querySelector('#board');
  buildBoard(boardEl, engine.field, view);
  buildPowerupRow(section.querySelector('#pupGrid'));

  /* HUD cards. */
  const lh = section.querySelector('#leftHud');
  const rh = section.querySelector('#rightHud');
  view.hudByIdx = new Map();
  const half = Math.ceil(engine.players.length / 2);
  engine.players.slice(0, half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); lh.appendChild(c); });
  engine.players.slice(half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); rh.appendChild(c); });

  /* Visual timer. */
  const timerEl = section.querySelector('[data-timer]');
  if(initialSecs > 0){
    timerHandle = setInterval(() => {
      const remaining = Math.max(0, Math.ceil(initialSecs - engine.elapsed));
      timerEl.textContent = formatTime(remaining);
      if(remaining <= 0) stopTimer();
    }, 250);
  }

  /* Forfeit. */
  section.querySelector('[data-action="end-round"]').addEventListener('click', () => {
    if(endTransitionHandle != null) return;
    scheduleRoundEnd(ctx, {
      winnerIdx: null,
      durationSec: engine ? engine.elapsed : 0,
      kos: new Map(),
      reason: 'forfeit',
    });
  });

  engine.start();
}

function scheduleRoundEnd(ctx, result){
  if(endTransitionHandle != null) return;
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
  /* Board CSS uses --ts; size the grid to the actual field. */
  boardEl.style.gridTemplateColumns = `repeat(${field.width}, ${TS}px)`;
  boardEl.style.gridTemplateRows    = `repeat(${field.height}, ${TS}px)`;
  boardEl.style.position = 'relative';

  view.tileEls = new Array(field.width * field.height);

  for(let y = 0; y < field.height; y++){
    for(let x = 0; x < field.width; x++){
      const t = document.createElement('div');
      t.className = 'tile';
      const v = field.at(x, y);
      if(v === TILE.PILLAR){
        t.classList.add('stone');
      } else if(v === TILE.BOX){
        t.classList.add('grass', 'crate');
      } else {
        t.classList.add('grass');
        if((x + y) % 2 === 0) t.classList.add('b');
      }
      boardEl.appendChild(t);
      view.tileEls[y * field.width + x] = t;
    }
  }

  /* Layer stack. */
  view.pickupLayer    = makeLayer(field, 2);
  view.bombLayer      = makeLayer(field, 3);
  view.playerLayer    = makeLayer(field, 5);
  view.explosionLayer = makeLayer(field, 7);
  boardEl.appendChild(view.pickupLayer);
  boardEl.appendChild(view.bombLayer);
  boardEl.appendChild(view.playerLayer);
  boardEl.appendChild(view.explosionLayer);

  view.fieldWidth = field.width;
}

function makeLayer(field, z){
  const el = document.createElement('div');
  el.style.cssText = `
    position:absolute; left:0; top:0;
    width:${field.width * TS}px; height:${field.height * TS}px;
    pointer-events:none; z-index:${z};
  `;
  return el;
}

/* ============ PER-FRAME RENDERING ============ */

function renderPlayers(view, players, elapsed){
  if(!view.playerSprites){
    view.playerSprites = new Map();
    for(const p of players){
      const wrap = makePosWrapper();
      const inner = makeSpriteHolder(PLAYER_SIZE);
      inner.appendChild(charSvg(p.charId, PLAYER_SIZE));
      wrap.appendChild(inner);
      view.playerLayer.appendChild(wrap);
      view.playerSprites.set(p.idx, { wrap, inner });
    }
  }
  for(const p of players){
    const entry = view.playerSprites.get(p.idx);
    if(!entry) continue;
    entry.wrap.style.transform = `translate(${(p.x * TS).toFixed(2)}px, ${(p.y * TS).toFixed(2)}px)`;
    if(!p.alive){
      entry.inner.style.filter = 'grayscale(.7) opacity(.5)';
      entry.wrap.style.zIndex = '1';
    } else {
      let filter = '';
      const ghosting = elapsed != null && elapsed < p.ghostUntil;
      const slowed   = elapsed != null && elapsed < p.slowUntil;
      if(ghosting) filter += 'opacity(.55) ';
      if(slowed)   filter += 'hue-rotate(180deg) ';
      if(p.shieldStacks > 0) filter += 'drop-shadow(0 0 6px #ffd76b) ';
      entry.inner.style.filter = filter.trim();
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
      const wrap = makePosWrapper();
      /* Smooth tile-to-tile slide when the engine teleports the bomb during
         a kick.  No animation if it just sits — it never gets a different
         tile from one render to the next. */
      wrap.style.transition = 'transform 0.12s linear';
      const inner = makeSpriteHolder(BOMB_SIZE);
      inner.classList.add('breathe');
      inner.appendChild(bombSvg(false, BOMB_SIZE));
      wrap.appendChild(inner);
      view.bombLayer.appendChild(wrap);
      entry = { wrap, inner, hot: false };
      view.bombSprites.set(b.id, entry);
    }
    entry.wrap.style.transform = `translate(${((b.x + 0.5) * TS).toFixed(2)}px, ${((b.y + 0.5) * TS).toFixed(2)}px)`;
    const shouldBeHot = b.fuse <= HOT_THRESHOLD;
    if(shouldBeHot && !entry.hot){
      entry.hot = true;
      entry.inner.classList.remove('breathe');
      entry.inner.classList.add('hot-pulse');
      entry.inner.innerHTML = '';
      entry.inner.appendChild(bombSvg(true, BOMB_SIZE));
    }
  }
  for(const [id, entry] of view.bombSprites){
    if(!seen.has(id)){ entry.wrap.remove(); view.bombSprites.delete(id); }
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
        const inner = makeSpriteHolder(BLAST_SIZE);
        inner.classList.add('pulse-fast');
        wrap.style.transform = `translate(${((s.x + 0.5) * TS).toFixed(2)}px, ${((s.y + 0.5) * TS).toFixed(2)}px)`;
        let svg;
        if(s.kind === 'center') svg = blastCenterSvg(BLAST_SIZE);
        else if(s.kind === 'arm-h') svg = blastArmSvg(BLAST_SIZE, false);
        else svg = blastArmSvg(BLAST_SIZE, true);
        inner.appendChild(svg);
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

function renderPickups(view, pickups){
  if(!view.pickupSprites) view.pickupSprites = new Map();
  const seen = new Set();
  for(const pk of pickups){
    seen.add(pk.id);
    let entry = view.pickupSprites.get(pk.id);
    if(!entry){
      const wrap = makePosWrapper();
      /* Smooth slide when a magnet drags the pickup across tiles. */
      wrap.style.transition = `transform 0.22s ease-out`;
      const inner = makeSpriteHolder(PICKUP_SIZE);
      inner.classList.add('pulse-slow');
      const meta = PUPS[pk.type] || PUPS.bomb;
      const chip = document.createElement('span');
      chip.style.cssText = `display:flex; align-items:center; justify-content:center; width:${PICKUP_SIZE}px; height:${PICKUP_SIZE}px; background:${meta.bg}; border:2.5px solid var(--ink); border-radius:10px; box-shadow:0 3px 0 rgba(43,33,80,.18)`;
      chip.appendChild(pupSvg(pk.type, PICKUP_SIZE - 14));
      inner.appendChild(chip);
      wrap.appendChild(inner);
      view.pickupLayer.appendChild(wrap);
      entry = { wrap };
      view.pickupSprites.set(pk.id, entry);
    }
    /* Always sync transform — magnet may have moved the pickup. */
    entry.wrap.style.transform = `translate(${((pk.x + 0.5) * TS).toFixed(2)}px, ${((pk.y + 0.5) * TS).toFixed(2)}px)`;
  }
  for(const [id, entry] of view.pickupSprites){
    if(!seen.has(id)){ entry.wrap.remove(); view.pickupSprites.delete(id); }
  }
}

/* ============ DOM HELPERS ============ */

function makePosWrapper(){
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute; left:0; top:0; will-change: transform;';
  return div;
}
function makeSpriteHolder(size){
  const div = document.createElement('div');
  div.style.cssText = `
    position:absolute;
    width:${size}px; height:${size}px;
    margin-left:${-size/2}px; margin-top:${-size/2}px;
    display:flex; align-items:center; justify-content:center;
  `;
  return div;
}

/* ============ EVENTS ============ */

function handleEvents(events, view, engine){
  for(const ev of events){
    if(ev.type === 'boxBroken'){
      const t = view.tileEls[ev.y * view.fieldWidth + ev.x];
      if(t){ t.classList.remove('crate'); }
    } else if(ev.type === 'playerKilled'){
      const card = view.hudByIdx.get(ev.idx);
      if(card) card.classList.add('dead');
    } else if(ev.type === 'pickupTaken'){
      const card = view.hudByIdx.get(ev.idx);
      if(card){
        const pups = card.querySelector('[data-pups]');
        if(pups){
          const meta = PUPS[ev.pickup.type] || PUPS.bomb;
          const slot = document.createElement('span');
          slot.className = 'pup';
          slot.style.background = meta.bg;
          slot.appendChild(pupSvg(ev.pickup.type, 18));
          pups.appendChild(slot);
        }
      }
    }
  }
}

/* ============ HUD + PUP REFERENCE ============ */

function buildPowerupRow(grid){
  for(const id of ALL_PUP_IDS){
    const meta = PUPS[id]; if(!meta) continue;
    const cell = document.createElement('div');
    cell.className = 'pup-cell';
    const iconSlot = document.createElement('span');
    iconSlot.className = 'icon';
    iconSlot.style.background = meta.bg;
    iconSlot.appendChild(pupSvg(id, 22));
    const info = document.createElement('span');
    info.className = 'info';
    info.innerHTML = `<span class="nm">${meta.nm}</span><span class="ds">${meta.ds}</span>`;
    cell.appendChild(iconSlot);
    cell.appendChild(info);
    grid.appendChild(cell);
  }
}

function buildHudCard(p, match){
  const card = document.createElement('div');
  card.className = 'pcard';
  card.dataset.idx = p.idx;
  const matchPlayer = match?.players?.find(x => x.idx === p.idx);
  const wins = matchPlayer?.score || 0;
  if(wins > 0 && (match?.players?.[0]?.idx === p.idx)) card.classList.add('lead');

  /* Control row text. */
  let ctrlInner;
  if(p.scheme && SCHEME_KEY_LABEL[p.scheme]){
    const k = SCHEME_KEY_LABEL[p.scheme];
    ctrlInner = `<span class="key">${k.move}</span><span class="key">${k.bomb}</span>`;
  } else if(p.type === 'cpu'){
    ctrlInner = `CPU · waiting on Etappe 6`;
  } else {
    ctrlInner = `—`;
  }

  card.innerHTML = `
    <div class="row" data-row1></div>
    <div class="hearts" data-hearts></div>
    <div class="pups" data-pups></div>
    <div class="ctrl-row">${ctrlInner}</div>
  `;

  /* Lead crown (if winning so far). */
  if(card.classList.contains('lead')){
    const crown = document.createElement('span');
    crown.className = 'crown';
    crown.appendChild(crownSvg(28));
    card.prepend(crown);
  }

  /* Avatar + name + score. */
  const row1 = card.querySelector('[data-row1]');
  const face = document.createElement('span');
  face.className = 'face-sm';
  face.appendChild(charSvg(p.charId, { w: 54, h: 54 }));
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || CHARS[p.charId]?.name || ('P' + (p.idx + 1));
  const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = wins > 0 ? `${wins}W` : '—';
  row1.appendChild(face); row1.appendChild(nm); row1.appendChild(sc);

  /* Heart row — 3 hearts. We don't have HP yet; all start full. */
  const hearts = card.querySelector('[data-hearts]');
  for(let i = 0; i < 3; i++){
    const slot = document.createElement('span');
    slot.appendChild(heartSvg(18));
    hearts.appendChild(slot);
  }
  return card;
}
