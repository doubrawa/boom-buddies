import { charSvg, icoSvg, CHARS, CHAR_IDS } from '../sprites.js';
import { createHost, createClient, generateRoomCode } from '../net/peer.js';
import {
  MSG_JOIN, MSG_LOBBY, MSG_START, MSG_PICK, MSG_WELCOME,
  encode,
} from '../net/protocol.js';

let activePeer = null;     // host or client object — closed in teardown

export function teardown(){
  if(activePeer){ try { activePeer.close(); } catch {} activePeer = null; }
}

export function render(ctx){
  const { app, navigate } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';
  section.innerHTML = `
    <div class="lobby">
      <div class="topbar-nav">
        <button class="back" data-action="back">◀ Back</button>
        <div></div>
      </div>
      <h2>Play with friends</h2>
      <p class="lead">Create a room to host, or join one with a code.</p>

      <div class="twocol">
        <div class="panel">
          <div class="panel-h"><span class="pip" style="background:var(--mint)"></span>Host a room</div>
          <p style="font-size:13px;color:var(--mid);font-weight:600;margin:0 0 14px">You'll get a 4-letter code; share it with up to 7 friends.</p>
          <button class="pillbtn primary" data-action="host"><span class="ic" data-spr-ico="play"></span>Create room<span class="arr">›</span></button>
        </div>
        <div class="panel">
          <div class="panel-h"><span class="pip" style="background:var(--lav)"></span>Join with a code</div>
          <p style="font-size:13px;color:var(--mid);font-weight:600;margin:0 0 14px">Type the 4-letter code your friend shared.</p>
          <input data-input="code" maxlength="4" placeholder="CODE" style="font-family:'Fredoka';font-weight:700;font-size:28px;text-transform:uppercase;letter-spacing:.16em;background:var(--cream);border:3px solid var(--ink);border-radius:12px;padding:10px 16px;width:100%;text-align:center;margin-bottom:12px"/>
          <button class="pillbtn" data-action="join"><span class="ic" data-spr-ico="mp"></span>Join room<span class="arr">›</span></button>
        </div>
      </div>

      <div data-host-area style="display:none;margin-top:24px"></div>
      <div data-client-area style="display:none;margin-top:24px"></div>
      <div data-status style="margin-top:18px;font-size:14px;color:var(--ink2);font-weight:700;min-height:1.4em"></div>
    </div>
  `;
  app.appendChild(section);

  /* Icons. */
  section.querySelectorAll('[data-spr-ico]').forEach(el => {
    el.appendChild(icoSvg(el.getAttribute('data-spr-ico'), 18));
  });

  const status = section.querySelector('[data-status]');
  function setStatus(msg, kind){
    status.textContent = msg;
    status.style.color = kind === 'err' ? 'var(--hot)' : 'var(--ink2)';
  }

  section.querySelector('[data-action="back"]').addEventListener('click', () => {
    teardown();
    navigate('title');
  });

  /* ============ HOST FLOW ============ */
  section.querySelector('[data-action="host"]').addEventListener('click', async () => {
    setStatus('Reserving a room…');
    const code = generateRoomCode();
    /* `host` is assigned below after the await; the helpers reference it
       via closure so they pick up the value once it's set. */
    let host = null;

    /* The host assigns each joining guest a buddy and a unique display
       name.  Whatever charId the guest reported is ignored — we always
       pick the first unused buddy ourselves.  If the requested name is
       already in use, suffix it with " (2)", " (3)", etc.  When the
       assignment differs from what the client sent, echo MSG_PICK back
       so the client's local state mirrors ours. */
    function assignGuestIdentity(guest){
      if(!host) return;
      const me = ctx.lobby.players[0];

      const takenChars = new Set([me.id]);
      for(const g of host.guests.values()){
        if(g === guest) continue;
        if(g.charId) takenChars.add(g.charId);
      }
      const newChar = pickAvailableForGuest(takenChars);

      const takenNames = new Set([me.name]);
      for(const g of host.guests.values()){
        if(g === guest) continue;
        if(g.name) takenNames.add(g.name);
      }
      const base = ((guest.name || 'Buddy').trim()) || 'Buddy';
      let newName = base;
      let suffix = 2;
      while(takenNames.has(newName)) newName = `${base} (${suffix++})`;

      const charChanged = newChar !== guest.charId;
      const nameChanged = newName !== guest.name;
      guest.charId = newChar;
      guest.name = newName;
      if(charChanged || nameChanged){
        host.sendTo(guest, { t: MSG_PICK, charId: newChar, name: newName });
      }
    }

    /* Push the live lobby roster to every connected guest so their
       roster panel mirrors the host's view (including any deduped
       character reassignment). */
    function broadcastLobby(){
      if(!host) return;
      const me = ctx.lobby.players[0];
      const players = [{ id: me.id, name: me.name, kind: 'host' }];
      for(const g of host.guests.values()){
        players.push({
          id: g.charId || 'mochi',
          name: g.name || 'Buddy',
          kind: 'remote',
        });
      }
      const payload = { t: MSG_LOBBY, state: { players } };
      for(const g of host.guests.values()){
        host.sendTo(g, payload);
      }
    }

    try {
      host = await createHost(code, {
        onGuestConnect: () => { refreshHostUi(); broadcastLobby(); },
        onGuestDisconnect: () => { refreshHostUi(); broadcastLobby(); },
        onMessage: (guest, msg) => {
          if(msg.t === MSG_JOIN || msg.t === MSG_PICK){
            assignGuestIdentity(guest);
            refreshHostUi();
            broadcastLobby();
          }
        },
        onError: (err) => setStatus('Network error: ' + err.type || err.message, 'err'),
      });
      activePeer = host;
      ctx.net = { role: 'host', host, code };
      showHostUi(section, ctx, code);
      setStatus(`Room ${code} ready — share the code with friends.`);
    } catch(err){
      setStatus('Could not host: ' + (err.message || err.type || 'unknown'), 'err');
    }
  });

  /* ============ CLIENT FLOW ============ */
  section.querySelector('[data-action="join"]').addEventListener('click', async () => {
    const codeInput = section.querySelector('[data-input="code"]');
    const code = (codeInput.value || '').trim().toUpperCase();
    if(code.length !== 4){
      setStatus('Codes are 4 letters/digits.', 'err');
      return;
    }
    setStatus(`Connecting to room ${code}…`);
    try {
      const myName = ctx.lobby.players[0]?.name || 'Buddy';
      const myChar = pickAvailableChar(ctx);
      const client = await createClient(code, {
        onMessage: (msg) => handleClientMessage(ctx, section, msg),
        onDisconnect: () => {
          setStatus('Host left — back to menu.', 'err');
          ctx.net = null;
          activePeer = null;
          setTimeout(() => navigate('title'), 1500);
        },
        onError: (err) => setStatus('Network error: ' + (err.type || err.message), 'err'),
      });
      activePeer = client;
      ctx.net = { role: 'client', client, code, charId: myChar };
      client.send({ t: MSG_JOIN, name: myName, charId: myChar });
      showClientUi(section, ctx, code, myChar);
      setStatus(`Connected — waiting for host to start.`);
    } catch(err){
      setStatus('Could not join: ' + (err.message || err.type || 'unknown'), 'err');
    }
  });

  function showHostUi(section, ctx, code){
    const host = ctx.net.host;
    const area = section.querySelector('[data-host-area]');
    area.style.display = 'block';
    area.innerHTML = `
      <div class="panel">
        <div class="panel-h"><span class="pip"></span>Room <span style="font-family:'Fredoka';font-weight:700;font-size:24px;letter-spacing:.18em;background:var(--butter);border:3px solid var(--ink);border-radius:12px;padding:4px 14px;margin-left:8px">${code}</span><span class="ct">share with up to 7 friends</span></div>
        <div data-roster style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px"></div>
        <button class="pillbtn primary" data-action="start-host"><span class="ic" data-spr-ico="play"></span>Start the chaos!<span class="arr">›</span></button>
      </div>
    `;
    area.querySelector('[data-spr-ico="play"]').appendChild(icoSvg('play', 18));
    area.querySelector('[data-action="start-host"]').addEventListener('click', () => {
      /* Build the lobby state for the match: host's player + each connected
         guest gets a slot.  Off slots fill the rest. */
      const playerSlots = [];
      const taken = new Set();
      const myCharId = ctx.lobby.players[0].id;
      const myName = ctx.lobby.players[0].name;
      playerSlots.push({ id: myCharId, name: myName, mode: 'human', kind: 'host', peerId: null });
      taken.add(myCharId);
      for(const g of host.guests.values()){
        let cid = g.charId || pickAvailableForGuest(taken);
        if(taken.has(cid)) cid = pickAvailableForGuest(taken);
        taken.add(cid);
        g.idx = playerSlots.length;
        playerSlots.push({ id: cid, name: g.name || 'Buddy', mode: 'human', kind: 'remote', peerId: g.conn.peer });
      }
      while(playerSlots.length < 8) playerSlots.push({ id: CHAR_IDS[playerSlots.length], name: '—', mode: 'off' });

      const matchLobby = {
        ...ctx.lobby,
        players: playerSlots,
      };
      ctx.lobby = matchLobby;
      ctx.net.matchLobby = matchLobby;
      /* Tell each guest their idx + the lobby. */
      for(const g of host.guests.values()){
        host.sendTo(g, { t: MSG_WELCOME, idx: g.idx, lobby: matchLobby });
        host.sendTo(g, { t: MSG_START, lobby: matchLobby });
      }
      navigate('game');
    });

    refreshHostUi();
  }

  function refreshHostUi(){
    const host = activePeer;
    if(!host || host.role !== 'host') return;
    const area = section.querySelector('[data-host-area]');
    if(!area) return;
    const roster = area.querySelector('[data-roster]');
    if(!roster) return;
    roster.innerHTML = '';
    /* Host slot first. */
    roster.appendChild(buddyChip(ctx.lobby.players[0].id, ctx.lobby.players[0].name + ' (you)', true));
    for(const g of host.guests.values()){
      roster.appendChild(buddyChip(g.charId || 'mochi', g.name || 'Buddy', false));
    }
  }

  function showClientUi(section, ctx, code, charId){
    const area = section.querySelector('[data-client-area]');
    area.style.display = 'block';
    area.innerHTML = `
      <div class="panel">
        <div class="panel-h"><span class="pip"></span>In room <span style="font-family:'Fredoka';font-weight:700;font-size:24px;letter-spacing:.18em;background:var(--butter);border:3px solid var(--ink);border-radius:12px;padding:4px 14px;margin-left:8px">${code}</span></div>
        <div data-client-roster style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px"></div>
        <p style="font-size:13px;color:var(--mid);font-weight:600;margin:0">Waiting for the host to start the chaos…</p>
      </div>
    `;
  }
}

function pickAvailableChar(ctx){
  /* For the joining client, default to the first character their lobby
     state had selected. */
  return ctx.lobby?.players?.[0]?.id || 'mochi';
}

function pickAvailableForGuest(taken){
  for(const id of CHAR_IDS) if(!taken.has(id)) return id;
  return 'mochi';
}

function buddyChip(charId, name, isHost){
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;align-items:center;gap:8px;background:#fff;border:2.5px solid var(--ink);border-radius:999px;padding:6px 14px 6px 6px;box-shadow:0 3px 0 var(--ink)';
  const face = document.createElement('span');
  face.style.cssText = 'width:34px;height:34px;border-radius:50%;background:var(--cream);border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none;position:relative';
  const fsvg = charSvg(charId, { w: 40, h: 40 });
  fsvg.style.cssText = 'margin:-3px 0 0 -3px';
  face.appendChild(fsvg);
  const lbl = document.createElement('span');
  lbl.style.cssText = `font-family:'Fredoka';font-weight:600;font-size:13px;color:var(--ink)`;
  lbl.textContent = isHost ? `${name} ⭐` : name;
  div.appendChild(face);
  div.appendChild(lbl);
  return div;
}

/* ============ CLIENT MESSAGE HANDLER ============ */
function handleClientMessage(ctx, section, msg){
  if(msg.t === MSG_WELCOME){
    ctx.net.myIdx = msg.idx;
    ctx.net.matchLobby = msg.lobby;
  } else if(msg.t === MSG_PICK){
    /* Host reassigned our character and/or name to keep the room
       unique.  Sync local state so the next lobby refresh shows us
       under the new identity. */
    if(msg.charId){
      ctx.net.charId = msg.charId;
      if(ctx.lobby?.players?.[0]) ctx.lobby.players[0].id = msg.charId;
    }
    if(msg.name){
      ctx.net.name = msg.name;
      if(ctx.lobby?.players?.[0]) ctx.lobby.players[0].name = msg.name;
    }
  } else if(msg.t === MSG_LOBBY){
    ctx.net.matchLobby = msg.state || msg.lobby;
    /* Refresh roster display. */
    const area = section.querySelector('[data-client-roster]');
    if(area){
      area.innerHTML = '';
      const players = (ctx.net.matchLobby?.players || []).filter(p => p.mode !== 'off');
      players.forEach((p, i) => {
        area.appendChild(buddyChip(p.id, p.name, p.kind === 'host'));
      });
    }
  } else if(msg.t === MSG_START){
    ctx.lobby = msg.lobby;
    ctx.navigate('game');
  }
}
