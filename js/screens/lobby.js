import { charSvg, icoSvg, CHAR_IDS, CHARS } from '../sprites.js';
import { CONTROL_SCHEMES } from '../game/input.js';

const FIELD_SIZES = [
  { id:'small',  w:11, h:9,  label:'Cozy',    meta:['~2 min rounds', '2–3 buddies'] },
  { id:'medium', w:15, h:13, label:'Classic', meta:['~3 min rounds', '4–6 buddies'] },
  { id:'large',  w:19, h:17, label:'Chaos',   meta:['~5 min rounds', '6–8 buddies'] },
];

/* Slot-index → preferred control scheme for human players. */
const HUMAN_SCHEME_ORDER = ['wasd', 'arrows', 'ijkl', 'numpad'];

const REBIND_GLYPH = { up:'↑', down:'↓', left:'←', right:'→', bomb:'💣' };

/* Pretty short labels for KeyboardEvent.code values shown on the lobby
   key chips. */
function formatKeyCode(code){
  if(!code) return '?';
  const map = {
    Space: '␣', Enter: '⏎', Tab: '⇥', Escape: 'Esc', Backspace: '⌫',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: '⇧L', ShiftRight: '⇧R',
    ControlLeft: '⌃L', ControlRight: '⌃R',
    AltLeft: '⌥L', AltRight: '⌥R',
    MetaLeft: '⌘L', MetaRight: '⌘R',
  };
  if(map[code]) return map[code];
  if(code.startsWith('Key'))    return code.slice(3);
  if(code.startsWith('Digit'))  return code.slice(5);
  if(code.startsWith('Numpad')) return 'N' + code.slice(6);
  return code;
}

const DEFAULT_NAMES = ['Mochi', 'Bubble', 'Biscuit', 'Pickle', 'Plum', 'Sage', 'Daisy', 'Cocoa'];
const DEFAULT_MODES = ['human', 'human', 'cpu', 'cpu', 'cpu', 'cpu', 'off', 'off'];

export function defaultLobbyState(){
  return {
    fieldSize: 'medium',
    rounds: 3,
    timeLimit: 150,
    goodieFreq: 1,                  // 0=sparse 1=normal 2=generous
    speed: 'normal',                // 'slow' | 'normal' | 'fast'
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

      <div class="panel">
        <div class="panel-h"><span class="pip" style="background:var(--lav)"></span>Rules</div>
        <div class="twocol">
          <div>
            <div class="opt-lbl">Best of</div>
            <div class="seg-row" data-seg="rounds">
              <span data-val="1" class="${state.rounds===1?'on':''}">1</span>
              <span data-val="3" class="${state.rounds===3?'on':''}">3</span>
              <span data-val="5" class="${state.rounds===5?'on':''}">5</span>
              <span data-val="7" class="${state.rounds===7?'on':''}">7</span>
            </div>
            <div class="opt-lbl">Speed</div>
            <div class="seg-row" data-seg="speed">
              <span data-val="slow"   class="${state.speed==='slow'?'on':''}">Slow</span>
              <span data-val="normal" class="${state.speed==='normal'?'on':''}">Normal</span>
              <span data-val="fast"   class="${state.speed==='fast'?'on':''}">Fast</span>
            </div>
          </div>
          <div>
            <div class="opt-lbl">Time limit</div>
            <div class="seg-row" data-seg="time">
              <span data-val="90"  class="${state.timeLimit===90?'on':''}">1:30</span>
              <span data-val="150" class="${state.timeLimit===150?'on':''}">2:30</span>
              <span data-val="210" class="${state.timeLimit===210?'on':''}">3:30</span>
              <span data-val="0"   class="${state.timeLimit===0?'on':''}">∞</span>
            </div>
            <div class="opt-lbl">Goodie drops</div>
            <div class="seg-row" data-seg="goodies">
              <span data-val="0" class="${state.goodieFreq===0?'on':''}">Sparse</span>
              <span data-val="1" class="${state.goodieFreq===1?'on':''}">Normal</span>
              <span data-val="2" class="${state.goodieFreq===2?'on':''}">Generous</span>
            </div>
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
        const raw = s.getAttribute('data-val');
        const val = isNaN(parseInt(raw, 10)) ? raw : parseInt(raw, 10);
        if(key === 'rounds')  state.rounds = val;
        if(key === 'time')    state.timeLimit = val;
        if(key === 'speed')   state.speed = val;
        if(key === 'goodies') state.goodieFreq = val;
      });
    });
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

function buildSlots(host, state){
  host.innerHTML = '';
  state.players.forEach((p, i) => {
    const slot = document.createElement('div');
    slot.className = 'pslot ' + (p.mode === 'off' ? 'empty' : (p.mode === 'cpu' ? 'cpu' : ''));
    slot.dataset.idx = i;
    const bindings = getBindings(state, i);
    const ctrlInner = p.mode === 'human' && bindings
      ? (
          ['up','down','left','right','bomb']
            .map(k => `<span class="key" data-rebind="${k}" title="Click to rebind">${REBIND_GLYPH[k]}${formatKeyCode(bindings[k])}</span>`)
            .join('')
          + `<span class="lbl">click a key to rebind</span>`
        )
      : (p.mode === 'cpu' ? `<span class="lbl">A CPU buddy.</span>` : `<span class="lbl">tap a tab to add</span>`);
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

    /* Key rebinding — clicking any chip puts the slot in capture mode
       and the next keypress becomes the new binding for that action. */
    slot.querySelectorAll('[data-rebind]').forEach(chip => {
      chip.addEventListener('click', () => beginRebind(host, state, i, chip.getAttribute('data-rebind')));
    });
  });
}

/* Returns the effective bindings for slot `i`, falling back to the slot's
   preset scheme when the user hasn't rebound anything yet. */
function getBindings(state, i){
  const p = state.players[i];
  if(!p || p.mode !== 'human') return null;
  if(p.bindings) return p.bindings;
  const scheme = humanSchemeFor(state, i);
  return scheme ? { ...CONTROL_SCHEMES[scheme] } : null;
}

let activeRebind = null;   // closes the previous capture if user starts a new one

function beginRebind(host, state, i, action){
  if(activeRebind) activeRebind.cancel();
  const slot = host.querySelector(`.pslot[data-idx="${i}"]`);
  if(!slot) return;
  const chip = slot.querySelector(`[data-rebind="${action}"]`);
  if(!chip) return;
  const originalHTML = chip.innerHTML;
  chip.classList.add('rebinding');
  chip.innerHTML = `${REBIND_GLYPH[action]}…`;

  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true);
    activeRebind = null;
  };

  function onKey(e){
    if(e.code === 'Escape'){
      e.preventDefault();
      chip.classList.remove('rebinding');
      chip.innerHTML = originalHTML;
      cleanup();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    /* Persist the new binding on the slot.  Start from the current
       effective bindings so the other 4 actions stay intact. */
    const current = state.players[i].bindings || (() => {
      const scheme = humanSchemeFor(state, i);
      return scheme ? { ...CONTROL_SCHEMES[scheme] } : { up:null, down:null, left:null, right:null, bomb:null };
    })();
    current[action] = e.code;
    state.players[i].bindings = current;
    chip.classList.remove('rebinding');
    chip.innerHTML = `${REBIND_GLYPH[action]}${formatKeyCode(e.code)}`;
    cleanup();
  }

  activeRebind = { cancel: () => { chip.classList.remove('rebinding'); chip.innerHTML = originalHTML; cleanup(); } };
  window.addEventListener('keydown', onKey, true);
}

/* Scheme is bound to the slot's *active* position so toggling human → cpu
   doesn't shift bindings onto later avatars.  P1=human (WASD), P2=human
   (arrows), P3=human (ijkl), P4=human (numpad).  Switch P2 → cpu and the
   schemes stay: P1=WASD, P3=ijkl, P4=numpad — P2's arrows binding is
   simply parked, not transferred.  Only OFF slots are excluded from the
   counter (an OFF slot never had a scheme to keep). */
function humanSchemeFor(state, idx){
  if(state.players[idx].mode !== 'human') return null;
  let activeBefore = 0;
  for(let i = 0; i < idx; i++){
    if(state.players[i].mode !== 'off') activeBefore++;
  }
  return HUMAN_SCHEME_ORDER[activeBefore] || null;
}

function activeCount(state){
  return state.players.filter(p => p.mode !== 'off').length;
}

function updateRosterCount(scope, state){
  const el = scope.querySelector?.('[data-roster-count]') || document.querySelector('[data-roster-count]');
  if(el) el.textContent = `${activeCount(state)}/8 active`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
