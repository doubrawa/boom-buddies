/* ======================================================
   BOOM BUDDIES — sprite library (v2)
   All sprites are drawn pixel-by-pixel into <canvas>
   elements at base resolution. CSS scales them up with
   image-rendering: pixelated for crisp pixel-art output.
   ====================================================== */

export const INK = '#2a1f3d';
export const INK2 = '#4a3a5e';
export const WHT = '#fff8e7';
export const CHK = '#ff7aa3';

/* ---------- low-level pixel helpers ---------- */
function px(ctx, x, y, c){ if(!c) return; ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); }
function rect(ctx, x, y, w, h, c){ if(!c) return; ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
function fillEll(ctx, cx, cy, rx, ry, c){
  for(let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for(let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++){
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if(dx*dx + dy*dy <= 1) px(ctx, x, y, c);
    }
}
function strokeEll(ctx, cx, cy, rx, ry, c){
  const ins = {};
  for(let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for(let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++){
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if(dx*dx + dy*dy <= 1) ins[x + ',' + y] = 1;
    }
  for(const k in ins){
    const [a, b] = k.split(',').map(Number);
    if(!ins[(a-1)+','+b] || !ins[(a+1)+','+b] || !ins[a+','+(b-1)] || !ins[a+','+(b+1)]) px(ctx, a, b, c);
  }
}
function strokeRect(ctx, x, y, w, h, c){
  for(let i = x; i < x + w; i++){ px(ctx, i, y, c); px(ctx, i, y+h-1, c); }
  for(let i = y; i < y + h; i++){ px(ctx, x, i, c); px(ctx, x+w-1, i, c); }
}

/* ---------- 8 distinct characters ---------- */
export const CHARS = {
  bubble:  { body:'#6dd5e8', dark:'#3aa3bf', acc:'ears',   eye:'round',   mouth:'smile'  },
  mochi:   { body:'#ff9ec7', dark:'#c8567f', acc:'bow',    eye:'sparkle', mouth:'uwu'    },
  biscuit: { body:'#f5d958', dark:'#b89b1f', acc:'chef',   eye:'happy',   mouth:'grin'   },
  pickle:  { body:'#7ed98a', dark:'#3a9447', acc:'leaf',   eye:'dot',     mouth:'tongue' },
  yam:     { body:'#ff9b6e', dark:'#c46434', acc:'avi',    eye:'goggles', mouth:'smile'  },
  plum:    { body:'#b58ee8', dark:'#6b4ec1', acc:'wiz',    eye:'sleepy',  mouth:'oh'     },
  peach:   { body:'#ffb3c8', dark:'#c87890', acc:'flower', eye:'star',    mouth:'smile'  },
  mallow:  { body:'#f5ece0', dark:'#a89e8e', acc:'beanie', eye:'snore',   mouth:'zz'     },
};

export const CHAR_IDS = Object.keys(CHARS);

function drawBase(c, body, dark){
  fillEll(c, 16, 14, 11, 10, body);
  for(let yy = 20; yy < 24; yy++) for(let xx = 6; xx < 26; xx++){
    const dx = (xx + 0.5 - 16) / 11, dy = (yy + 0.5 - 14) / 10;
    if(dx*dx + dy*dy <= 1) px(c, xx, yy, dark);
  }
  strokeEll(c, 16, 14, 11, 10, INK);
  px(c,8,17,CHK); px(c,9,17,CHK); px(c,23,17,CHK); px(c,24,17,CHK);
  rect(c, 12, 23, 8, 4, body); rect(c, 12, 25, 8, 2, dark); strokeRect(c, 12, 23, 8, 4, INK);
  rect(c, 5, 18, 3, 3, body); strokeRect(c, 5, 18, 3, 3, INK);
  rect(c, 24, 18, 3, 3, body); strokeRect(c, 24, 18, 3, 3, INK);
  rect(c, 11, 27, 4, 3, dark); strokeRect(c, 11, 27, 4, 3, INK);
  rect(c, 17, 27, 4, 3, dark); strokeRect(c, 17, 27, 4, 3, INK);
}

function drawEyes(c, k, ly){
  ly = ly || 14; const lx = 11, rx = 20;
  if(k === 'round'){ for(const cx of [lx,rx]){ rect(c, cx-1, ly-1, 3, 4, WHT); rect(c, cx-1, ly, 2, 2, INK); px(c, cx, ly-1, WHT); }}
  else if(k === 'sparkle'){ for(const cx of [lx,rx]){ rect(c, cx-1, ly-2, 3, 5, WHT); rect(c, cx-1, ly, 2, 3, INK); px(c, cx, ly-1, WHT); px(c, cx-1, ly+1, WHT); }}
  else if(k === 'happy'){ for(const cx of [lx,rx]){ px(c, cx-2, ly, INK); px(c, cx+1, ly, INK); px(c, cx-1, ly-1, INK); px(c, cx, ly-1, INK); }}
  else if(k === 'dot'){ for(const cx of [lx,rx]) rect(c, cx-1, ly, 2, 2, INK); }
  else if(k === 'goggles'){ for(const cx of [lx,rx]){ strokeEll(c, cx, ly, 3, 3, INK); fillEll(c, cx, ly, 2, 2, '#7ec4ff'); px(c, cx-1, ly-1, WHT); } for(let i = lx+3; i <= rx-3; i++) px(c, i, ly, INK); }
  else if(k === 'sleepy'){ for(const cx of [lx,rx]){ px(c, cx-2, ly, INK); px(c, cx-1, ly, INK); px(c, cx, ly, INK); px(c, cx+1, ly, INK); px(c, cx-2, ly+1, INK); px(c, cx+1, ly+1, INK); }}
  else if(k === 'snore'){ for(const cx of [lx,rx]){ px(c, cx-1, ly-1, INK); px(c, cx, ly-1, INK); px(c, cx-2, ly, INK); px(c, cx+1, ly, INK); px(c, cx-1, ly+1, INK); px(c, cx, ly+1, INK); }}
  else if(k === 'star'){ for(const cx of [lx,rx]){ rect(c, cx-1, ly-1, 3, 4, WHT); rect(c, cx-1, ly, 2, 2, INK); px(c, cx, ly-1, '#ffe79e'); px(c, cx-1, ly+1, WHT); }}
}

function drawMouth(c, k, my){
  my = my || 19;
  if(k === 'smile'){ px(c, 15, my, INK); px(c, 16, my, INK); px(c, 14, my-1, INK); px(c, 17, my-1, INK); }
  else if(k === 'oh'){ rect(c, 15, my-1, 2, 2, '#c84277'); strokeRect(c, 15, my-1, 2, 2, INK); }
  else if(k === 'grin'){ rect(c, 13, my, 6, 2, INK); rect(c, 14, my, 4, 1, '#fff'); px(c, 15, my+1, '#ff7aa3'); px(c, 16, my+1, '#ff7aa3'); }
  else if(k === 'uwu'){ px(c, 13, my, INK); px(c, 14, my-1, INK); px(c, 15, my, INK); px(c, 16, my, INK); px(c, 17, my-1, INK); px(c, 18, my, INK); }
  else if(k === 'tongue'){ px(c, 15, my, INK); px(c, 16, my, INK); px(c, 15, my+1, '#ff7aa3'); px(c, 16, my+1, '#ff7aa3'); px(c, 14, my-1, INK); px(c, 17, my-1, INK); }
  else if(k === 'zz'){ px(c, 15, my, INK); px(c, 16, my, INK); px(c, 17, my, INK); }
}

function drawAcc(c, k, body){
  if(k === 'ears'){
    for(let y = 0; y < 8; y++){ rect(c, 9, y, 3, 1, body); rect(c, 20, y, 3, 1, body); }
    for(let y = 2; y < 7; y++){ px(c, 10, y, '#ff9bbb'); px(c, 21, y, '#ff9bbb'); }
    for(let y = 0; y < 8; y++){ px(c, 8, y, INK); px(c, 12, y, INK); px(c, 19, y, INK); px(c, 23, y, INK); }
    rect(c, 9, 0, 3, 1, INK); rect(c, 20, 0, 3, 1, INK);
  } else if(k === 'bow'){
    rect(c, 17, 2, 4, 3, '#ff6b9d'); rect(c, 21, 1, 4, 5, '#ff6b9d'); rect(c, 25, 2, 3, 3, '#ff6b9d');
    rect(c, 22, 3, 2, 1, '#c84277');
    strokeRect(c, 17, 2, 4, 3, INK); strokeRect(c, 21, 1, 4, 5, INK); strokeRect(c, 25, 2, 3, 3, INK);
  } else if(k === 'chef'){
    fillEll(c, 12, 2, 4, 2, WHT); fillEll(c, 17, 1, 4, 2, WHT); fillEll(c, 22, 2, 4, 2, WHT);
    rect(c, 9, 4, 14, 2, WHT); strokeRect(c, 9, 4, 14, 2, INK);
    strokeEll(c, 12, 2, 4, 2, INK); strokeEll(c, 17, 1, 4, 2, INK); strokeEll(c, 22, 2, 4, 2, INK);
  } else if(k === 'leaf'){
    rect(c, 12, 2, 8, 4, '#3a9447');
    rect(c, 11, 3, 1, 2, '#3a9447'); rect(c, 20, 3, 1, 2, '#3a9447');
    rect(c, 15, 3, 1, 3, '#7ed98a');
    px(c, 16, 1, '#3a9447'); px(c, 16, 0, '#3a9447');
    strokeRect(c, 12, 2, 8, 4, INK); px(c, 11, 3, INK); px(c, 11, 4, INK); px(c, 20, 3, INK); px(c, 20, 4, INK);
  } else if(k === 'avi'){
    rect(c, 7, 4, 18, 3, '#a96e34'); rect(c, 8, 3, 16, 1, '#a96e34');
    rect(c, 9, 7, 14, 1, '#7d4d22');
    strokeRect(c, 7, 4, 18, 3, INK);
    px(c, 8, 3, INK); px(c, 23, 3, INK);
  } else if(k === 'wiz'){
    px(c, 16, 0, '#5b3aa8');
    rect(c, 15, 1, 3, 1, '#5b3aa8'); rect(c, 14, 2, 5, 1, '#5b3aa8'); rect(c, 13, 3, 7, 1, '#5b3aa8');
    rect(c, 12, 4, 9, 1, '#5b3aa8'); rect(c, 11, 5, 11, 1, '#5b3aa8');
    rect(c, 8, 6, 17, 2, '#5b3aa8'); rect(c, 7, 7, 19, 1, '#3a2370');
    px(c, 16, 4, '#ffe79e'); px(c, 15, 5, '#ffe79e'); px(c, 17, 5, '#ffe79e');
    px(c, 16, 0, INK); px(c, 15, 1, INK); px(c, 18, 1, INK); px(c, 14, 2, INK); px(c, 19, 2, INK);
    px(c, 13, 3, INK); px(c, 20, 3, INK); px(c, 12, 4, INK); px(c, 21, 4, INK); px(c, 11, 5, INK); px(c, 22, 5, INK);
    strokeRect(c, 7, 7, 19, 1, INK); strokeRect(c, 8, 6, 17, 2, INK);
  } else if(k === 'flower'){
    fillEll(c, 7, 4, 2, 2, '#ffa3c0'); fillEll(c, 11, 4, 2, 2, '#ffa3c0');
    fillEll(c, 9, 2, 2, 2, '#ffa3c0'); fillEll(c, 9, 6, 2, 2, '#ffa3c0');
    fillEll(c, 9, 4, 2, 2, '#ff6b9d');
    px(c, 9, 4, '#ffe79e');
    px(c, 12, 5, '#3a9447'); px(c, 13, 6, '#3a9447');
  } else if(k === 'beanie'){
    rect(c, 8, 3, 16, 4, '#7ec4ff'); rect(c, 8, 5, 16, 1, '#3a7ec4');
    rect(c, 9, 7, 14, 1, '#cfe9ff');
    fillEll(c, 16, 1, 2, 2, '#fff8e7');
    strokeRect(c, 8, 3, 16, 4, INK); strokeEll(c, 16, 1, 2, 2, INK);
  }
}

export function drawChar(ctx, id){
  const s = CHARS[id]; if(!s) return;
  drawBase(ctx, s.body, s.dark);
  drawAcc(ctx, s.acc, s.body);
  drawEyes(ctx, s.eye);
  drawMouth(ctx, s.mouth);
}

/* ---------- BOMB (24x24) ---------- */
export function drawBomb(c, hot){
  const B = hot ? '#ff4a55' : '#3b2a55', D = hot ? '#a82030' : '#1a1228', H = hot ? '#ff8a90' : '#7a6494';
  fillEll(c, 12, 14, 8, 8, B);
  for(let yy = 10; yy < 22; yy++) for(let xx = 4; xx < 20; xx++){
    const dx = (xx + 0.5 - 12) / 8, dy = (yy + 0.5 - 14) / 8;
    if(dx*dx + dy*dy <= 1 && yy >= 15 && xx >= 12) px(c, xx, yy, D);
  }
  fillEll(c, 9, 11, 2, 2, H);
  px(c, 8, 10, WHT);
  strokeEll(c, 12, 14, 8, 8, INK);
  rect(c, 10, 13, 2, 3, WHT); rect(c, 14, 13, 2, 3, WHT);
  px(c, 11, 14, INK); px(c, 15, 14, INK);
  px(c, 8, 17, '#ff9bbb'); px(c, 17, 17, '#ff9bbb');
  px(c, 12, 18, INK); px(c, 13, 18, INK);
  rect(c, 11, 5, 4, 2, INK); rect(c, 12, 7, 2, 1, INK);
  px(c, 13, 4, '#5a4570'); px(c, 14, 3, '#5a4570'); px(c, 15, 2, '#5a4570');
  if(hot){
    px(c, 16, 1, '#ff7a3d'); px(c, 17, 0, '#ffe79e'); px(c, 17, 2, '#ff7a3d'); px(c, 18, 1, '#ffe79e');
  } else {
    px(c, 16, 1, '#ff7a3d'); px(c, 17, 0, '#ffe79e');
  }
}

/* ---------- BOX (16x16) ---------- */
export function drawBox(c){
  rect(c, 0, 0, 16, 16, '#a96e34');
  rect(c, 1, 1, 14, 14, '#d49758');
  rect(c, 2, 2, 12, 12, '#ecc28e');
  rect(c, 3, 3, 10, 10, '#d49758');
  for(let i = 0; i < 10; i++){ px(c, 3+i, 3+i, '#a96e34'); px(c, 3+i, 12-i, '#a96e34'); }
  strokeRect(c, 0, 0, 16, 16, INK);
  rect(c, 5, 7, 2, 2, WHT); rect(c, 9, 7, 2, 2, WHT);
  px(c, 5, 7, INK); px(c, 9, 7, INK);
  px(c, 6, 8, INK); px(c, 10, 8, INK);
  px(c, 4, 9, '#ff9bbb'); px(c, 11, 9, '#ff9bbb');
  px(c, 7, 10, INK); px(c, 8, 10, INK);
}

/* ---------- PILLAR (16x16) ---------- */
export function drawPillar(c){
  rect(c, 0, 0, 16, 16, '#7d6996');
  rect(c, 1, 1, 14, 14, '#9a96b5');
  for(let i = 0; i < 16; i++){ px(c, i, 5, '#7d6996'); px(c, i, 10, '#7d6996'); }
  for(let i = 1; i < 5; i++) px(c, 4, i, '#7d6996');
  for(let i = 6; i < 10; i++) px(c, 8, i, '#7d6996');
  for(let i = 11; i < 15; i++) px(c, 4, i, '#7d6996');
  for(let i = 11; i < 15; i++) px(c, 11, i, '#7d6996');
  rect(c, 2, 2, 2, 1, '#cfccdf');
  strokeRect(c, 0, 0, 16, 16, INK);
  px(c, 6, 7, INK); px(c, 9, 7, INK);
  px(c, 7, 8, INK); px(c, 8, 8, INK);
}

/* ---------- EXPLOSION ---------- */
export function drawExCenter(c){
  fillEll(c, 8, 8, 7, 7, '#ff7a3d');
  fillEll(c, 8, 8, 5, 5, '#ffb061');
  fillEll(c, 8, 8, 3, 3, '#ffe79e');
  fillEll(c, 8, 8, 1, 1, WHT);
  strokeEll(c, 8, 8, 7, 7, INK);
  px(c, 1, 8, INK); px(c, 14, 8, INK);
  px(c, 8, 1, INK); px(c, 8, 14, INK);
}
export function drawExArm(c){
  for(let x = 0; x < 16; x++){ rect(c, x, 4, 1, 8, '#ff7a3d'); }
  for(let x = 1; x < 15; x++) rect(c, x, 5, 1, 6, '#ffb061');
  for(let x = 2; x < 14; x++) rect(c, x, 6, 1, 4, '#ffe79e');
  for(let x = 4; x < 12; x++) rect(c, x, 7, 1, 2, WHT);
  for(let x = 0; x < 16; x++){ px(c, x, 4, INK); px(c, x, 11, INK); }
}

/* ---------- HEART (8x8) — vertically centered: occupies rows 2..6 ---------- */
export function drawHeart(c, empty){
  const R = empty ? '#d8c8e0' : '#ff6b9d', H = '#ffb3c8', D = empty ? '#a89aab' : '#c84277';
  rect(c, 1, 2, 2, 1, R); rect(c, 5, 2, 2, 1, R);
  rect(c, 1, 3, 6, 1, R);
  rect(c, 2, 4, 4, 1, R);
  rect(c, 3, 5, 2, 1, D);
  px(c, 2, 2, H);
  px(c, 0, 2, INK); px(c, 3, 2, INK); px(c, 4, 2, INK); px(c, 7, 2, INK);
  px(c, 0, 3, INK); px(c, 7, 3, INK);
  px(c, 1, 4, INK); px(c, 6, 4, INK);
  px(c, 2, 5, INK); px(c, 5, 5, INK);
  px(c, 3, 6, INK); px(c, 4, 6, INK);
}

/* ---------- POWER-UPS (16x16) ---------- */
export const PUPS = {
  bomb:   { nm:'+ BOMB',  ds:'CARRY ONE MORE BOMB' },
  fire:   { nm:'+ RANGE', ds:'BIGGER BLAST CROSS' },
  speed:  { nm:'+ SPEED', ds:'WALK FASTER' },
  remote: { nm:'REMOTE',  ds:'DETONATE ON COMMAND' },
  kick:   { nm:'KICK',    ds:'PUSH BOMBS WITH FOOT' },
  glove:  { nm:'THROW',   ds:'PICK UP & THROW' },
  ghost:  { nm:'GHOST',   ds:'WALK THRU WALLS' },
  shield: { nm:'SHIELD',  ds:'SURVIVE 1 BLAST' },
  ice:    { nm:'ICE',     ds:'FREEZE ENEMIES' },
  magnet: { nm:'MAGNET',  ds:'PULLS UPS IN' },
  slow:   { nm:'SLOW-MO', ds:'SLOWS OTHERS' },
  super:  { nm:'SUPER',   ds:'BLAST TO WALL' },
};

export function drawPup(c, id){
  if(id === 'bomb'){
    fillEll(c, 8, 9, 5, 5, '#ff6b9d'); strokeEll(c, 8, 9, 5, 5, INK);
    fillEll(c, 6, 7, 1, 1, '#ffa3c0');
    rect(c, 7, 3, 3, 1, INK); px(c, 8, 5, INK); px(c, 9, 4, '#5a4570'); px(c, 10, 3, '#5a4570'); px(c, 11, 2, '#ff7a3d'); px(c, 12, 1, '#ffe79e');
    rect(c, 6, 8, 2, 2, WHT); rect(c, 9, 8, 2, 2, WHT); px(c, 7, 9, INK); px(c, 10, 9, INK);
    px(c, 5, 11, '#ffa3c0'); px(c, 11, 11, '#ffa3c0');
  } else if(id === 'fire'){
    px(c, 8, 2, '#ffe79e');
    rect(c, 7, 3, 2, 1, '#ffb061');
    rect(c, 6, 4, 4, 1, '#ff7a3d');
    rect(c, 5, 5, 6, 1, '#ff7a3d');
    rect(c, 4, 6, 8, 1, '#ff4a55');
    rect(c, 3, 7, 10, 2, '#ff4a55');
    rect(c, 3, 9, 10, 2, '#ff7a3d');
    rect(c, 4, 11, 8, 1, '#ffb061');
    rect(c, 5, 12, 6, 1, '#ffe79e');
    rect(c, 6, 13, 4, 1, WHT);
    px(c, 8, 1, INK); px(c, 8, 2, INK);
    px(c, 3, 7, INK); px(c, 12, 7, INK); px(c, 3, 10, INK); px(c, 12, 10, INK);
    px(c, 2, 8, INK); px(c, 13, 8, INK); px(c, 2, 9, INK); px(c, 13, 9, INK);
    px(c, 5, 4, INK); px(c, 10, 4, INK); px(c, 4, 5, INK); px(c, 11, 5, INK);
    px(c, 6, 13, INK); px(c, 9, 13, INK); px(c, 7, 14, INK); px(c, 8, 14, INK);
  } else if(id === 'speed'){
    rect(c, 2, 8, 12, 3, '#ffe79e');
    rect(c, 2, 11, 12, 2, '#d49758');
    rect(c, 3, 7, 10, 1, '#fff8e7');
    rect(c, 4, 6, 8, 1, '#fff8e7');
    rect(c, 11, 5, 3, 3, '#ffe79e');
    px(c, 5, 7, '#ff6b9d'); px(c, 7, 7, '#ff6b9d'); px(c, 9, 7, '#ff6b9d');
    px(c, 4, 12, '#ff4a55'); px(c, 8, 12, '#ff4a55'); px(c, 12, 12, '#ff4a55');
    strokeRect(c, 2, 8, 12, 3, INK);
    strokeRect(c, 2, 11, 12, 2, INK);
    px(c, 11, 5, INK); px(c, 13, 5, INK); px(c, 14, 8, INK);
    px(c, 0, 9, INK); px(c, 0, 10, INK);
  } else if(id === 'remote'){
    rect(c, 3, 3, 10, 10, '#3b2a55'); strokeRect(c, 3, 3, 10, 10, INK);
    rect(c, 4, 4, 8, 3, '#7ec4ff'); rect(c, 5, 5, 6, 1, '#ffe79e');
    px(c, 6, 5, INK); px(c, 9, 5, INK);
    rect(c, 5, 8, 2, 1, '#ff4a55'); rect(c, 9, 8, 2, 1, '#ff4a55');
    rect(c, 5, 10, 2, 1, WHT); rect(c, 9, 10, 2, 1, WHT);
    px(c, 8, 12, '#ff4a55'); px(c, 7, 12, '#ff4a55');
    px(c, 12, 2, INK); px(c, 13, 1, INK); px(c, 14, 0, '#ffe79e');
  } else if(id === 'kick'){
    rect(c, 3, 4, 4, 8, '#ff7a3d');
    rect(c, 3, 11, 9, 2, '#a8431f');
    rect(c, 7, 7, 5, 5, '#ff7a3d');
    rect(c, 4, 5, 2, 2, '#ffb061');
    strokeRect(c, 3, 4, 4, 8, INK);
    strokeRect(c, 3, 11, 9, 2, INK);
    strokeRect(c, 7, 7, 5, 5, INK);
    fillEll(c, 13, 11, 2, 2, '#3b2a55');
    strokeEll(c, 13, 11, 2, 2, INK);
    px(c, 15, 9, '#ff7a3d');
  } else if(id === 'glove'){
    rect(c, 4, 3, 8, 8, '#7ec4ff');
    rect(c, 3, 5, 2, 4, '#7ec4ff');
    rect(c, 4, 11, 8, 3, '#3a7ec4');
    rect(c, 5, 4, 6, 1, '#cfe9ff');
    strokeRect(c, 4, 3, 8, 8, INK);
    strokeRect(c, 3, 5, 2, 4, INK);
    strokeRect(c, 4, 11, 8, 3, INK);
    px(c, 6, 7, INK); px(c, 8, 7, INK); px(c, 10, 7, INK);
  } else if(id === 'ghost'){
    fillEll(c, 8, 7, 5, 5, WHT);
    rect(c, 3, 7, 11, 5, WHT);
    rect(c, 3, 12, 2, 1, WHT); rect(c, 6, 12, 2, 1, WHT); rect(c, 9, 12, 2, 1, WHT); rect(c, 12, 12, 2, 1, WHT);
    rect(c, 4, 13, 1, 1, WHT); rect(c, 7, 13, 1, 1, WHT); rect(c, 10, 13, 1, 1, WHT); rect(c, 13, 13, 1, 1, WHT);
    strokeEll(c, 8, 7, 5, 5, INK);
    px(c, 3, 12, INK); px(c, 5, 12, INK); px(c, 6, 12, INK); px(c, 8, 12, INK); px(c, 9, 12, INK); px(c, 11, 12, INK); px(c, 12, 12, INK); px(c, 14, 12, INK);
    px(c, 4, 13, INK); px(c, 7, 13, INK); px(c, 10, 13, INK); px(c, 13, 13, INK);
    rect(c, 6, 7, 1, 2, INK); rect(c, 9, 7, 1, 2, INK);
    px(c, 5, 9, '#ff9bbb'); px(c, 11, 9, '#ff9bbb');
  } else if(id === 'shield'){
    rect(c, 4, 2, 8, 2, '#7ec4ff');
    rect(c, 3, 4, 10, 5, '#7ec4ff');
    rect(c, 4, 9, 8, 2, '#7ec4ff');
    rect(c, 5, 11, 6, 1, '#7ec4ff');
    rect(c, 6, 12, 4, 1, '#7ec4ff');
    rect(c, 7, 13, 2, 1, '#7ec4ff');
    px(c, 8, 5, '#ffe79e'); rect(c, 7, 6, 3, 1, '#ffe79e'); rect(c, 6, 7, 5, 1, '#ffe79e'); rect(c, 7, 8, 3, 1, '#ffe79e'); px(c, 8, 9, '#ffe79e');
    px(c, 4, 2, INK); px(c, 11, 2, INK); px(c, 3, 4, INK); px(c, 12, 4, INK);
    px(c, 3, 8, INK); px(c, 12, 8, INK); px(c, 4, 9, INK); px(c, 11, 9, INK);
    px(c, 5, 11, INK); px(c, 10, 11, INK); px(c, 6, 12, INK); px(c, 9, 12, INK);
    px(c, 7, 13, INK); px(c, 8, 13, INK);
    rect(c, 4, 3, 8, 1, '#cfe9ff');
  } else if(id === 'ice'){
    fillEll(c, 8, 9, 5, 5, '#cfe9ff'); strokeEll(c, 8, 9, 5, 5, INK);
    rect(c, 7, 3, 3, 1, INK); px(c, 8, 5, INK); px(c, 9, 4, '#7ec4ff'); px(c, 10, 3, WHT);
    rect(c, 6, 8, 2, 2, WHT); rect(c, 9, 8, 2, 2, WHT); px(c, 7, 9, INK); px(c, 10, 9, INK);
    px(c, 3, 3, WHT); px(c, 4, 4, '#7ec4ff'); px(c, 3, 5, WHT);
    px(c, 13, 3, WHT); px(c, 14, 2, '#7ec4ff');
  } else if(id === 'magnet'){
    rect(c, 3, 3, 3, 8, '#ff4a55'); rect(c, 10, 3, 3, 8, '#ff4a55');
    rect(c, 3, 3, 10, 2, '#ff4a55');
    rect(c, 3, 3, 3, 3, '#fff8e7'); rect(c, 10, 3, 3, 3, '#fff8e7');
    rect(c, 3, 11, 3, 2, WHT); rect(c, 10, 11, 3, 2, WHT);
    strokeRect(c, 3, 3, 3, 10, INK); strokeRect(c, 10, 3, 3, 10, INK);
    rect(c, 6, 3, 4, 2, '#ff4a55'); strokeRect(c, 3, 3, 10, 2, INK);
    px(c, 1, 7, '#ffe79e'); px(c, 14, 7, '#ffe79e');
    px(c, 2, 2, '#ffe79e'); px(c, 13, 1, '#ffe79e');
  } else if(id === 'slow'){
    fillEll(c, 8, 9, 6, 6, WHT); strokeEll(c, 8, 9, 6, 6, INK);
    fillEll(c, 8, 9, 5, 5, '#fff8e7');
    px(c, 8, 4, INK); px(c, 8, 14, INK); px(c, 3, 9, INK); px(c, 13, 9, INK);
    rect(c, 8, 6, 1, 3, INK); rect(c, 8, 9, 4, 1, INK);
    px(c, 8, 9, '#ff4a55');
    rect(c, 7, 2, 3, 2, '#3a3550'); strokeRect(c, 7, 2, 3, 2, INK);
  } else if(id === 'super'){
    fillEll(c, 8, 9, 5, 5, '#ff4a55'); strokeEll(c, 8, 9, 5, 5, INK);
    px(c, 5, 7, '#ffe79e'); px(c, 11, 7, '#ffe79e'); px(c, 5, 11, '#ffe79e'); px(c, 11, 11, '#ffe79e'); px(c, 8, 9, '#ffe79e');
    rect(c, 7, 3, 3, 1, INK); px(c, 9, 4, '#5a4570'); px(c, 10, 3, '#ff7a3d'); px(c, 11, 2, '#ffe79e'); px(c, 12, 1, WHT);
    rect(c, 6, 8, 2, 2, WHT); rect(c, 9, 8, 2, 2, WHT); px(c, 7, 9, INK); px(c, 10, 9, INK);
    px(c, 5, 12, '#ffe79e'); px(c, 11, 12, '#ffe79e');
  }
}

/* ---------- ICONS (10x10) ---------- */
export function drawIco(c, k){
  if(k === 'play'){
    rect(c, 3, 2, 1, 6, INK);
    for(let i = 0; i < 6; i++) rect(c, 4, 2+i, Math.min(6-i, 4), 1, '#ff6b9d');
    px(c, 3, 2, INK); px(c, 3, 7, INK); px(c, 4, 2, INK); px(c, 4, 7, INK);
    px(c, 5, 3, INK); px(c, 5, 6, INK); px(c, 6, 4, INK); px(c, 6, 5, INK); px(c, 7, 4, INK); px(c, 7, 5, INK); px(c, 8, 4, INK); px(c, 8, 5, INK);
  } else if(k === 'mp'){
    fillEll(c, 3, 5, 2, 2, '#7ec4ff'); strokeEll(c, 3, 5, 2, 2, INK);
    fillEll(c, 7, 5, 2, 2, '#ff6b9d'); strokeEll(c, 7, 5, 2, 2, INK);
  } else if(k === 'cog'){
    fillEll(c, 5, 5, 3, 3, '#9fe0b8'); strokeEll(c, 5, 5, 3, 3, INK);
    fillEll(c, 5, 5, 1, 1, INK);
    px(c, 5, 1, INK); px(c, 5, 8, INK); px(c, 1, 5, INK); px(c, 8, 5, INK);
    px(c, 2, 2, INK); px(c, 7, 2, INK); px(c, 2, 7, INK); px(c, 7, 7, INK);
  } else if(k === 'cup'){
    rect(c, 2, 2, 6, 4, '#ffe79e');
    rect(c, 3, 6, 4, 1, '#ffe79e');
    rect(c, 3, 7, 4, 1, '#a96e34');
    rect(c, 2, 8, 6, 1, '#a96e34');
    strokeRect(c, 2, 2, 6, 4, INK);
    px(c, 2, 8, INK); px(c, 7, 8, INK);
  } else if(k === 'back'){
    px(c, 2, 5, '#ff6b9d'); px(c, 3, 4, '#ff6b9d'); px(c, 3, 5, '#ff6b9d'); px(c, 3, 6, '#ff6b9d');
    rect(c, 4, 5, 5, 1, '#ff6b9d');
    px(c, 3, 4, INK); px(c, 3, 6, INK); px(c, 2, 5, INK); px(c, 8, 5, INK);
  } else if(k === 'net'){
    fillEll(c, 5, 5, 4, 4, '#7ec4ff'); strokeEll(c, 5, 5, 4, 4, INK);
    rect(c, 1, 5, 8, 1, INK); rect(c, 5, 1, 1, 8, INK);
    px(c, 3, 3, INK); px(c, 7, 3, INK); px(c, 3, 7, INK); px(c, 7, 7, INK);
  }
}

/* ---------- CROWN (20x12) ---------- */
export function drawCrown(c){
  rect(c, 1, 8, 18, 3, '#ffd34d');
  rect(c, 1, 3, 3, 5, '#ffd34d');
  rect(c, 5, 5, 3, 3, '#ffd34d');
  rect(c, 9, 2, 2, 6, '#ffd34d');
  rect(c, 12, 5, 3, 3, '#ffd34d');
  rect(c, 16, 3, 3, 5, '#ffd34d');
  px(c, 2, 6, '#ff4a55'); px(c, 6, 7, '#7ec4ff'); px(c, 9, 5, '#ff6b9d'); px(c, 13, 7, '#7ed98a'); px(c, 17, 6, '#b58ee8');
  rect(c, 1, 8, 18, 1, '#ffe79e');
  strokeRect(c, 1, 8, 18, 3, INK);
  px(c, 1, 3, INK); px(c, 3, 3, INK); px(c, 1, 7, INK); px(c, 3, 7, INK); px(c, 4, 7, INK);
  px(c, 5, 5, INK); px(c, 7, 5, INK); px(c, 5, 7, INK); px(c, 7, 7, INK); px(c, 8, 7, INK);
  px(c, 9, 2, INK); px(c, 10, 2, INK); px(c, 9, 7, INK); px(c, 10, 7, INK); px(c, 11, 7, INK);
  px(c, 12, 5, INK); px(c, 14, 5, INK); px(c, 12, 7, INK); px(c, 14, 7, INK); px(c, 15, 7, INK);
  px(c, 16, 3, INK); px(c, 18, 3, INK); px(c, 16, 7, INK); px(c, 18, 7, INK);
  for(let y = 3; y < 8; y++){ px(c, 1, y, INK); px(c, 18, y, INK); }
}

/* ---------- CLOUD ---------- */
export function drawCloud(c, big){
  const w = c.canvas.width, h = c.canvas.height;
  fillEll(c, w*0.3, h*0.6, w*0.18, h*0.35, WHT);
  fillEll(c, w*0.5, h*0.5, w*0.22, h*0.45, WHT);
  fillEll(c, w*0.7, h*0.55, w*0.2, h*0.4, WHT);
  rect(c, 1, h-2, w-2, 1, WHT);
  if(big){ fillEll(c, w*0.85, h*0.65, w*0.12, h*0.3, WHT); }
}

/* ---------- SPARK ---------- */
export function drawSpark(c){
  px(c, 3, 0, '#ff7a3d'); px(c, 4, 1, '#ffe79e'); px(c, 3, 1, '#ff7a3d');
  px(c, 2, 2, '#ffe79e'); px(c, 3, 2, WHT); px(c, 4, 2, '#ffe79e');
  px(c, 3, 3, '#ff7a3d'); rect(c, 2, 4, 4, 1, '#ff7a3d');
  px(c, 1, 3, '#ffe79e'); px(c, 5, 3, '#ffe79e');
  px(c, 3, 5, '#ffe79e'); px(c, 3, 6, '#ff7a3d');
  px(c, 0, 3, WHT); px(c, 7, 3, WHT);
}

/* ---------- MINI BOARD PREVIEW ---------- */
export function drawMini(ctx, w, h){
  ctx.canvas.width = w * 4;
  ctx.canvas.height = h * 4;
  ctx.imageSmoothingEnabled = false;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    const isBorder = x === 0 || y === 0 || x === w-1 || y === h-1;
    const isPillar = x % 2 === 0 && y % 2 === 0;
    let col;
    if(isBorder || isPillar) col = '#7d6996';
    else if(((x+y) % 5 === 0) || ((x*7 + y*3) % 6 === 0)) col = '#d49758';
    else col = (x+y) % 2 ? '#d8eecf' : '#c8e3bd';
    if(x === 1 && y === 1) col = '#6dd5e8';
    if(x === w-2 && y === 1) col = '#ff9ec7';
    if(x === 1 && y === h-2) col = '#f5d958';
    if(x === w-2 && y === h-2) col = '#7ed98a';
    rect(ctx, x*4, y*4, 4, 4, col);
  }
}

/* ====================================================== */
/* Helpers: build canvas elements ready to insert in DOM.   */
/* ====================================================== */
export function makeCanvas(baseW, baseH, drawFn){
  const cv = document.createElement('canvas');
  cv.width = baseW;
  cv.height = baseH;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawFn(ctx);
  return cv;
}

export function charCanvas(id){ return makeCanvas(32, 32, ctx => drawChar(ctx, id)); }
export function bombCanvas(hot){ return makeCanvas(24, 24, ctx => drawBomb(ctx, !!hot)); }
export function boxCanvas(){ return makeCanvas(16, 16, drawBox); }
export function pillarCanvas(){ return makeCanvas(16, 16, drawPillar); }
export function exCenterCanvas(){ return makeCanvas(16, 16, drawExCenter); }
export function exArmCanvas(rotateDeg){
  const cv = makeCanvas(16, 16, drawExArm);
  if(rotateDeg) cv.style.transform = `rotate(${rotateDeg}deg)`;
  return cv;
}
export function heartCanvas(empty){ return makeCanvas(8, 8, ctx => drawHeart(ctx, !!empty)); }
export function pupCanvas(id){ return makeCanvas(16, 16, ctx => drawPup(ctx, id)); }
export function icoCanvas(kind){ return makeCanvas(10, 10, ctx => drawIco(ctx, kind)); }
export function crownCanvas(){ return makeCanvas(20, 12, drawCrown); }
export function cloudCanvas(big){ return makeCanvas(big ? 30 : 20, big ? 14 : 12, ctx => drawCloud(ctx, !!big)); }
export function sparkCanvas(){ return makeCanvas(8, 8, drawSpark); }
export function miniCanvas(w, h){
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  drawMini(ctx, w, h);
  return cv;
}
