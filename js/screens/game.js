import {
  charSvg, bombSvg, pupSvg, icoSvg, crownSvg,
  blastCenterSvg, blastArmSvg,
  PUPS, ALL_PUP_IDS, CHARS,
} from '../sprites.js';
import { createEngine } from '../game/engine.js';
import { TILE } from '../game/field.js';
import { SCHEME_LABEL, createInput } from '../game/input.js';
import { HOT_THRESHOLD } from '../game/bombs.js';
import {
  MSG_INPUT, MSG_STATE, MSG_FIELD, MSG_EVENTS, MSG_ROUNDEND, MSG_NEXTROUND, MSG_MATCHEND,
  encodeState, encodeField, encodeMatch, decodeMatch,
} from '../net/protocol.js';
import {
  sfxBombPlace, sfxExplosion, sfxPickup, sfxDeath, sfxShield, sfxRoundEnd,
  sfxEarthquake,
} from '../audio.js';

const SNAPSHOT_INTERVAL_MS = 50;       // 20 Hz state broadcast
const NET_INPUT_INTERVAL_MS = 50;      // client → host input cadence

/* Tile and sprite sizes are recomputed at every board build so the board
   fills a 16:9 monitor and shrinks gracefully on a phone.  All sprite
   sizes are derived from TS so proportions stay constant.  The constants
   below are the ratios — TS=42 was the original baseline. */
const PLAYER_RATIO = 40 / 42;
const BOMB_RATIO   = 36 / 42;
const BLAST_RATIO  = 40 / 42;
const PICKUP_RATIO = 28 / 42;
const TS_MIN = 22, TS_MAX = 64, TS_BASE = 42;
let TS = TS_BASE;
let PLAYER_SIZE = Math.round(TS * PLAYER_RATIO);
let BOMB_SIZE   = Math.round(TS * BOMB_RATIO);
let BLAST_SIZE  = Math.round(TS * BLAST_RATIO);
let PICKUP_SIZE = Math.round(TS * PICKUP_RATIO);

function computeTileSize(fieldW, fieldH){
  /* Pick a tile size that lets the board fill the available stage area.
       - On desktop the #app caps at 1700px; the two HUD sidebars take
         about 540px between them and another ~60px goes to borders +
         padding, leaving ~1100px of horizontal stage at the cap.
       - On phones (< 900px) the three-column grid collapses (see CSS
         media query) so the full viewport width is available.
     vReserve accounts for the timer/round-pill bar above the board and
     for chrome around the page. */
  const isMobile = window.innerWidth < 900;
  const appW = Math.min(window.innerWidth, 1700);
  const hReserve = isMobile ? 40  : 600;
  const vReserve = isMobile ? 380 : 200;
  const availW = Math.max(220, (isMobile ? window.innerWidth : appW) - hReserve);
  const availH = Math.max(220, window.innerHeight - vReserve);
  const ts = Math.min(Math.floor(availW / fieldW), Math.floor(availH / fieldH));
  return Math.max(TS_MIN, Math.min(TS_MAX, ts));
}

function applyTileSize(ts){
  TS = ts;
  PLAYER_SIZE = Math.round(TS * PLAYER_RATIO);
  BOMB_SIZE   = Math.round(TS * BOMB_RATIO);
  BLAST_SIZE  = Math.round(TS * BLAST_RATIO);
  PICKUP_SIZE = Math.round(TS * PICKUP_RATIO);
}

let engine = null;
let timerHandle = null;
let endTransitionHandle = null;
let netHandles = null;     // host: { broadcastInterval, off }; client: { sendInterval, input, off }
let detachTouch = null;    // cleanup for touch-pad listeners

const ROUND_END_DELAY_MS = 1500;

const SCHEME_KEY_LABEL = {
  wasd:   { move: 'WASD',  bomb: '␣' },
  arrows: { move: '↑↓←→', bomb: '⏎' },
  ijkl:   { move: 'IJKL',  bomb: 'U' },
  numpad: { move: '8456',  bomb: '0' },
};

export function render(ctx){
  if(ctx.net?.role === 'client') return renderClient(ctx);
  return renderHostOrLocal(ctx);
}

function renderHostOrLocal(ctx){
  const { app, navigate, lobby, match } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';
  const initialSecs = lobby.timeLimit || 0;
  const isHost = ctx.net?.role === 'host';

  section.innerHTML = gameShell(match, initialSecs);
  app.appendChild(section);

  /* Host-side input cache: keyed by player idx, set as guests' MSG_INPUT
     messages arrive.  The engine reads from here for 'remote' players. */
  const remoteInputs = new Map();

  /* Engine. */
  const view = {};
  engine = createEngine(lobby, {
    onEvents: (events) => {
      handleEvents(events, view, engine);
      if(isHost && events?.length){
        ctx.net.host.broadcast({ t: MSG_EVENTS, events: serializeEvents(events) });
      }
    },
    onRender: () => {
      renderPlayers(view, engine.players, engine.elapsed);
      renderBombs(view, engine.bombs);
      renderExplosions(view, engine.explosions);
      renderPickups(view, engine.pickups);
    },
    onRoundEnd: (result) => scheduleRoundEnd(ctx, result, isHost),
  }, {
    remoteInputProvider: (idx) => remoteInputs.get(idx) || { dx:0, dy:0, bomb:false },
  });

  /* Build static board + layers + HUD. */
  const boardEl = section.querySelector('#board');
  buildBoard(boardEl, engine.field, view);
  buildPowerupRow(section.querySelector('#pupGrid'));
  view.hudByIdx = new Map();
  const lh = section.querySelector('#leftHud');
  const rh = section.querySelector('#rightHud');
  const half = Math.ceil(engine.players.length / 2);
  engine.players.slice(0, half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); lh.appendChild(c); });
  engine.players.slice(half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); rh.appendChild(c); });

  /* Timer. */
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
    const result = { winnerIdx: null, durationSec: engine ? engine.elapsed : 0, kos: new Map(), reason: 'forfeit' };
    scheduleRoundEnd(ctx, result, isHost);
  });

  /* Touch controls — appears only on touch devices via @media. */
  detachTouch = attachTouchControls(section);

  /* Host network setup: broadcast field once, then state every interval, and
     wire MSG_INPUT messages from guests into remoteInputs. */
  if(isHost){
    ctx.net.host.broadcast({ t: MSG_FIELD, ...encodeField(engine.field) });
    /* Replace lobby's onMessage handler so MSG_INPUT during the match goes
       straight into our input cache. */
    ctx.net._onClientMessage = (guest, msg) => {
      if(msg.t === MSG_INPUT){
        remoteInputs.set(guest.idx, { dx: msg.dx | 0, dy: msg.dy | 0, bomb: !!msg.bomb });
      }
    };
    /* PeerJS connections are already open; replace per-conn data handlers. */
    for(const g of ctx.net.host.guests.values()){
      g.conn.removeAllListeners?.('data');
      g.conn.on?.('data', (raw) => {
        const m = typeof raw === 'string' ? safeParse(raw) : raw;
        if(m && ctx.net._onClientMessage) ctx.net._onClientMessage(g, m);
      });
    }
    const broadcastInterval = setInterval(() => {
      if(!engine) return;
      ctx.net.host.broadcast({ t: MSG_STATE, ...encodeState(engine) });
    }, SNAPSHOT_INTERVAL_MS);
    netHandles = { broadcastInterval };
  }
  /* For local mode netHandles stays null. */

  engine.start();
}

function safeParse(s){ try { return JSON.parse(s); } catch { return null; } }

/* Some engine events carry Map (kos in roundEnd).  Serialize for the wire. */
function serializeResult(r){
  return {
    winnerIdx: r.winnerIdx,
    durationSec: r.durationSec,
    kos: r.kos ? Array.from(r.kos.entries()) : [],
    reason: r.reason,
  };
}
function serializeEvents(events){
  /* Already plain JSON, just strip non-serializable bits.  Bomb objects are
     forwarded as id+x+y for renderer's box-broken / pickup-taken. */
  return events.map(ev => {
    if(ev.type === 'bombDetonated') return { type: 'bombDetonated' };
    if(ev.type === 'bombPlaced')    return { type: 'bombPlaced' };
    if(ev.type === 'pickupDropped') return { type: 'pickupDropped' };
    return ev;
  });
}

function gameShell(match, initialSecs){
  return `
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
    <div class="touch-pad" data-touch>
      <div class="stick">
        <button class="up"    data-key="KeyW">▲</button>
        <button class="down"  data-key="KeyS">▼</button>
        <button class="left"  data-key="KeyA">◀</button>
        <button class="right" data-key="KeyD">▶</button>
      </div>
      <button class="bomb" data-key="Space">BOMB</button>
    </div>
  `;
}

/* Wire each touch button to synthesize keydown/keyup so the existing input
   system picks it up.  Multi-touch friendly: separate touches on different
   buttons map to separate keys.  Returns a cleanup function. */
function attachTouchControls(section){
  const buttons = section.querySelectorAll('[data-touch] [data-key]');
  if(!buttons.length) return () => {};
  const dispatch = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
  const handlers = [];
  buttons.forEach(btn => {
    const code = btn.getAttribute('data-key');
    const onDown = (e) => { e.preventDefault(); btn.classList.add('held'); dispatch('keydown', code); };
    const onUp   = (e) => { e.preventDefault(); btn.classList.remove('held'); dispatch('keyup', code); };
    btn.addEventListener('touchstart', onDown, { passive: false });
    btn.addEventListener('touchend',   onUp,   { passive: false });
    btn.addEventListener('touchcancel',onUp,   { passive: false });
    /* Mouse fallback for desktop testing. */
    btn.addEventListener('mousedown',  onDown);
    btn.addEventListener('mouseup',    onUp);
    btn.addEventListener('mouseleave', onUp);
    handlers.push({ btn, onDown, onUp });
  });
  return () => {
    for(const { btn, onDown, onUp } of handlers){
      btn.removeEventListener('touchstart', onDown);
      btn.removeEventListener('touchend',   onUp);
      btn.removeEventListener('touchcancel',onUp);
      btn.removeEventListener('mousedown',  onDown);
      btn.removeEventListener('mouseup',    onUp);
      btn.removeEventListener('mouseleave', onUp);
    }
  };
}

function scheduleRoundEnd(ctx, result, isHost){
  if(endTransitionHandle != null) return;
  stopTimer();
  if(result.winnerIdx != null) sfxRoundEnd();
  endTransitionHandle = setTimeout(() => {
    endTransitionHandle = null;
    ctx.recordRound(result);
    /* Host broadcasts the post-update match state so clients land on roundend
       with the correct cumulative scores. */
    if(isHost && ctx.net?.host){
      ctx.net.host.broadcast({
        t: MSG_ROUNDEND,
        result: serializeResult(result),
        match: encodeMatch(ctx.match),
      });
    }
    ctx.navigate('roundend');
  }, ROUND_END_DELAY_MS);
}

export function teardown(){
  stopTimer();
  if(endTransitionHandle != null){ clearTimeout(endTransitionHandle); endTransitionHandle = null; }
  if(engine){ engine.stop(); engine = null; }
  if(netHandles){
    if(netHandles.broadcastInterval) clearInterval(netHandles.broadcastInterval);
    if(netHandles.sendInterval) clearInterval(netHandles.sendInterval);
    if(netHandles.input) netHandles.input.teardown?.();
    /* Drop the data handler — roundend / lobby will install their own. */
    if(netHandles.conn) netHandles.conn.removeAllListeners?.('data');
    netHandles = null;
  }
  if(detachTouch){ detachTouch(); detachTouch = null; }
}

/* ============ CLIENT MODE ============
   No engine.  We show the same DOM but feed the renderers from network
   snapshots.  Local input is captured and forwarded to the host. */
function renderClient(ctx){
  const { app, navigate, lobby, match } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';
  const initialSecs = lobby.timeLimit || 0;
  section.innerHTML = gameShell(match, initialSecs);
  app.appendChild(section);

  /* The remote-game container — same surface the renderers expect. */
  const remote = createRemoteGame(lobby);

  const view = {};
  /* HUD now, board on receipt of MSG_FIELD. */
  view.hudByIdx = new Map();
  const lh = section.querySelector('#leftHud');
  const rh = section.querySelector('#rightHud');
  const half = Math.ceil(remote.players.length / 2);
  remote.players.slice(0, half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); lh.appendChild(c); });
  remote.players.slice(half).forEach(p => { const c = buildHudCard(p, match); view.hudByIdx.set(p.idx, c); rh.appendChild(c); });
  buildPowerupRow(section.querySelector('#pupGrid'));
  const boardEl = section.querySelector('#board');

  /* Local input: send my action to host every NET_INPUT_INTERVAL_MS. */
  const input = createInput();
  let prevBomb = false;
  /* Default scheme is wasd for the local human; we treat the client as if it
     were Player 1 of its own keyboard. */
  const sendInterval = setInterval(() => {
    const r = input.read('wasd', prevBomb);
    prevBomb = r.bomb;
    ctx.net.client.send({ t: MSG_INPUT, dx: r.dx, dy: r.dy, bomb: r.bomb });
  }, NET_INPUT_INTERVAL_MS);

  /* Wire host messages — replace whatever online-lobby set. */
  ctx.net.client.conn.removeAllListeners?.('data');
  ctx.net.client.conn.on?.('data', (raw) => {
    const m = typeof raw === 'string' ? safeParse(raw) : raw;
    if(!m) return;
    handleClientNetMsg(m, ctx, view, remote, boardEl, section);
  });

  /* Forfeit: client just sends a leave message and goes home. */
  section.querySelector('[data-action="end-round"]').addEventListener('click', () => {
    navigate('title');
  });

  /* Visual timer mirrors received elapsed against initialSecs. */
  const timerEl = section.querySelector('[data-timer]');
  if(initialSecs > 0){
    timerHandle = setInterval(() => {
      const remaining = Math.max(0, Math.ceil(initialSecs - remote.elapsed));
      timerEl.textContent = formatTime(remaining);
    }, 250);
  }

  netHandles = { sendInterval, input, conn: ctx.net.client.conn };

  /* Touch controls — synthesized keystrokes feed the local input that ships
     to the host on the same interval. */
  detachTouch = attachTouchControls(section);
}

function handleClientNetMsg(m, ctx, view, remote, boardEl, section){
  if(m.t === MSG_FIELD){
    /* Build the board now that we know the layout. */
    const f = { width: m.width, height: m.height, tiles: m.tiles, at(x,y){
      if(x<0||y<0||x>=this.width||y>=this.height) return TILE.PILLAR;
      return this.tiles[y*this.width + x];
    }, set(x,y,v){
      if(x<0||y<0||x>=this.width||y>=this.height) return;
      this.tiles[y*this.width + x] = v;
    }};
    remote.field = f;
    buildBoard(boardEl, f, view);
  } else if(m.t === MSG_STATE){
    remote.applySnapshot(m);
    /* Render once per snapshot. */
    renderPlayers(view, remote.players, remote.elapsed);
    renderBombs(view, remote.bombs);
    renderExplosions(view, remote.explosions);
    renderPickups(view, remote.pickups);
  } else if(m.t === MSG_EVENTS){
    /* Forward to existing event handler. */
    handleEvents(m.events, view, remote);
  } else if(m.t === MSG_ROUNDEND){
    const result = {
      winnerIdx: m.result.winnerIdx,
      durationSec: m.result.durationSec,
      kos: new Map(m.result.kos || []),
      reason: m.result.reason,
    };
    /* Set match + lastRound from the host so roundend can render the same
       scoreboard the host sees. */
    if(m.match) ctx.match = decodeMatch(m.match);
    ctx.lastRound = result;
    setTimeout(() => ctx.navigate('roundend'), ROUND_END_DELAY_MS);
  } else if(m.t === MSG_NEXTROUND){
    ctx.navigate('game');
  } else if(m.t === MSG_MATCHEND){
    if(m.match) ctx.match = decodeMatch(m.match);
    ctx.navigate('roundend');   /* shows match-complete branch */
  }
}

/* Fake engine surface for the client.  Renderers read .field, .players,
   .bombs, .pickups, .explosions, .elapsed — same shape, no tick logic. */
function createRemoteGame(lobby){
  const active = lobby.players.filter(p => p.mode !== 'off');
  const players = active.map((cfg, i) => ({
    idx: i, charId: cfg.id, name: cfg.name, type: cfg.mode, scheme: null,
    x: 0, y: 0, alive: true,
    ghostUntil: 0, slowUntil: 0, shieldStacks: 0,
    bombMax: 1, bombsLive: 0, range: 2,
    hasRemote:false, hasKick:false, hasMagnet:false,
    passthrough: new Set(), collected: [],
  }));
  return {
    field: null,
    players,
    bombs: [],
    pickups: [],
    explosions: [],
    elapsed: 0,
    applySnapshot(snap){
      this.elapsed = snap.e || 0;
      for(const wp of snap.p || []){
        const p = players.find(x => x.idx === wp.i);
        if(!p) continue;
        p.x = wp.x; p.y = wp.y;
        p.alive = !!wp.a;
        p.ghostUntil = wp.g ? this.elapsed + 1 : 0;
        p.slowUntil  = wp.s ? this.elapsed + 1 : 0;
        p.shieldStacks = wp.sh ? 1 : 0;
      }
      this.bombs.length = 0;
      for(const b of snap.b || []){
        this.bombs.push({ id: b.i, x: b.x, y: b.y, fuse: b.hot ? 0.5 : 2.5, range: 2, detonating: false });
      }
      this.pickups.length = 0;
      for(const pu of snap.pu || []){
        this.pickups.push({ id: pu.i, type: pu.t, x: pu.x, y: pu.y });
      }
      this.explosions.length = 0;
      for(const ex of snap.ex || []){
        this.explosions.push({ ttl: ex.ttl, segments: (ex.s || []).map(s => ({ x: s.x, y: s.y, kind: s.k })) });
      }
    },
  };
}

function stopTimer(){ if(timerHandle){ clearInterval(timerHandle); timerHandle = null; } }
function formatTime(s){ const m = Math.floor(s/60), ss = String(s%60).padStart(2,'0'); return `${m}:${ss}`; }

/* ============ BOARD CONSTRUCTION ============ */

function buildBoard(boardEl, field, view){
  /* Recompute tile size for the current viewport before laying out, so
     the board fills the screen on desktop and shrinks on mobile. */
  applyTileSize(computeTileSize(field.width, field.height));
  view.TS = TS;
  boardEl.style.setProperty('--ts', `${TS}px`);
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
    const newX = (b.x + 0.5) * TS;
    const newY = (b.y + 0.5) * TS;
    /* If the bomb just wrapped from one edge to the other (kicked bombs
       loop around the field), the position jumps more than a single
       tile.  Without intervention the CSS transition animates that whole
       distance in 0.12 s — looking like the bomb scrolls back across the
       board.  Disable the transition for this update so the bomb simply
       teleports to its new tile instead. */
    if(entry.lastX !== undefined &&
       (Math.abs(newX - entry.lastX) > TS * 1.5 || Math.abs(newY - entry.lastY) > TS * 1.5)){
      entry.wrap.style.transition = 'none';
      entry.wrap.style.transform = `translate(${newX.toFixed(2)}px, ${newY.toFixed(2)}px)`;
      /* Force layout to commit the new transform with transition:none, then
         re-enable the transition for subsequent steps. */
      void entry.wrap.offsetWidth;
      entry.wrap.style.transition = 'transform 0.12s linear';
    } else {
      entry.wrap.style.transform = `translate(${newX.toFixed(2)}px, ${newY.toFixed(2)}px)`;
    }
    entry.lastX = newX; entry.lastY = newY;
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
    } else if(ev.type === 'bombPlaced'){
      sfxBombPlace();
    } else if(ev.type === 'bombDetonated'){
      sfxExplosion();
      /* Tiny screen shake on the board.  Add class, remove on animationend
         so repeated explosions retrigger crisply. */
      const board = view.bombLayer?.parentElement;
      if(board){
        board.classList.remove('boom-shake');
        void board.offsetWidth;        // force reflow so the class re-applies
        board.classList.add('boom-shake');
      }
    } else if(ev.type === 'playerKilled'){
      sfxDeath();
      const card = view.hudByIdx.get(ev.idx);
      if(card) card.classList.add('dead');
    } else if(ev.type === 'shieldUsed'){
      sfxShield();
    } else if(ev.type === 'earthquakeStarted'){
      sfxEarthquake();
      const board = view.bombLayer?.parentElement;
      if(board){
        board.classList.add('quake-shake');
        setTimeout(() => board.classList.remove('quake-shake'), ev.duration * 1000);
      }
    } else if(ev.type === 'pickupTaken'){
      sfxPickup();
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

  return card;
}
