import { charSvg, crownSvg, icoSvg, pupSvg, PUPS, CHARS } from '../sprites.js';
import { rankings, isMatchOver, matchChampion } from '../game/match.js';

const PLACE_GLYPH = ['','🥇','🥈','🥉'];

export function render(ctx){
  const { app, navigate, match, lastRound } = ctx;
  const matchOver = isMatchOver(match);
  const ranked = rankings(match);

  const champion = matchOver ? matchChampion(match) : null;
  const roundWinner = lastRound?.winnerIdx != null
    ? match.players.find(p => p.idx === lastRound.winnerIdx)
    : null;
  const podium = champion || roundWinner;

  let bannerText, subBanner;
  if(matchOver){
    bannerText = champion ? 'Match Champion!' : 'Match Draw!';
    subBanner = champion ? `${champion.name} · ${champion.score} round wins, ${champion.ko} K/Os total` : 'Tied at the top — no champion this match.';
  } else if(roundWinner){
    bannerText = 'Round Winner!';
    const lastKos = lastRound?.kos?.get?.(roundWinner.idx) || 0;
    subBanner = `${roundWinner.name} took round ${match.current - 1}${lastKos ? ` · ${lastKos} K/O${lastKos>1?'s':''}` : ' · clean run'}`;
  } else {
    bannerText = 'Round Draw!';
    subBanner = `Round ${match.current - 1} ended without a clear winner.`;
  }

  /* Top 3 for the podium (regardless of round winner — show match standings so far). */
  const top3 = ranked.slice(0, 3);

  const section = document.createElement('section');
  section.className = 'screen active';
  section.innerHTML = `
    <div class="we">
      <div class="conf" id="conf"></div>
      <h2 class="banner">${bannerText}</h2>
      <p class="subbanner">${subBanner}</p>

      <div class="podium" data-podium></div>

      <div class="scoreboard">
        <div class="sb-h">
          <span></span><span>Player</span><span>K/O</span><span>Power-ups</span><span>Time</span><span>Score</span>
        </div>
        <div data-rows></div>
      </div>

      <div class="actions">
        <button class="pillbtn" data-action="menu">
          <span class="ic" data-spr="ico-back"></span>
          Back to Menu
        </button>
        ${matchOver ? '' : `
        <button class="pillbtn primary" data-action="next">
          <span class="ic" data-spr="ico-play"></span>
          Next Round
          <span class="arr">›</span>
        </button>`}
      </div>
    </div>
  `;
  app.appendChild(section);

  /* Icons. */
  section.querySelectorAll('[data-spr="ico-back"]').forEach(el => el.appendChild(icoSvg('back', 18)));
  section.querySelectorAll('[data-spr="ico-play"]').forEach(el => el.appendChild(icoSvg('play', 18)));

  /* Podium — second / first / third left to right. */
  buildPodium(section.querySelector('[data-podium]'), top3);

  /* Scoreboard rows. */
  const rowsHost = section.querySelector('[data-rows]');
  ranked.forEach((p, i) => {
    const place = i + 1;
    const lastKos = lastRound?.kos?.get?.(p.idx) || 0;
    const score = p.score * 1000 + p.ko * 100;
    const lastTime = lastRound?.durationSec ? formatTime(lastRound.durationSec) : '—';
    rowsHost.appendChild(buildRow({ place, p, lastKos, score, lastTime, isWinner: place === 1 && podium }));
  });

  /* Confetti. */
  if(podium){
    const conf = section.querySelector('#conf');
    const palette = ['#ff7aa8','#ff9d76','#ffd76b','#7fd4b3','#c5a8ed','#a9d8ff'];
    for(let i = 0; i < 50; i++){
      const c = document.createElement('span');
      c.className = 'c';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = palette[i % palette.length];
      c.style.animationDelay = (Math.random() * 4) + 's';
      c.style.animationDuration = (3 + Math.random() * 3) + 's';
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      c.style.borderRadius = (Math.random() < 0.4) ? '50%' : '3px';
      conf.appendChild(c);
    }
  }

  section.querySelector('[data-action="menu"]').addEventListener('click', () => navigate('title'));
  const nextBtn = section.querySelector('[data-action="next"]');
  if(nextBtn) nextBtn.addEventListener('click', () => navigate('game'));
}

function buildPodium(host, top3){
  if(top3.length === 0) return;
  const second = top3[1];
  const first  = top3[0];
  const third  = top3[2];
  const cols = [];
  if(second) cols.push(makePodiumCol(second, 'second', false));
  if(first)  cols.push(makePodiumCol(first,  'first',  true));
  if(third)  cols.push(makePodiumCol(third,  'third',  false));
  cols.forEach(c => host.appendChild(c));
}

function makePodiumCol(p, place, isFirst){
  const col = document.createElement('div');
  col.className = 'col ' + place;
  const ch = document.createElement('div');
  ch.className = 'ch' + (isFirst ? ' first' : '');
  if(isFirst){
    const crown = document.createElement('span');
    crown.className = 'crown';
    crown.appendChild(crownSvg(56));
    ch.appendChild(crown);
  }
  ch.appendChild(charSvg(p.id, isFirst ? 160 : 120));
  const pname = document.createElement('div');
  pname.className = 'pname';
  pname.textContent = p.name;
  if(isFirst) pname.style.background = 'var(--butter)';
  const ped = document.createElement('div');
  ped.className = 'pedestal';
  ped.textContent = ({first:1, second:2, third:3})[place];
  col.appendChild(ch);
  col.appendChild(pname);
  col.appendChild(ped);
  return col;
}

function buildRow({ place, p, lastKos, score, lastTime, isWinner }){
  const row = document.createElement('div');
  row.className = 'sb-row' + (isWinner && place === 1 ? ' win' : '');

  const pos = document.createElement('span'); pos.className = 'pos';
  pos.textContent = PLACE_GLYPH[place] || place;

  const pn = document.createElement('span'); pn.className = 'pn';
  const face = document.createElement('span'); face.className = 'face-sb';
  face.appendChild(charSvg(p.id, { w: 42, h: 42 }));
  const nm = document.createElement('span'); nm.className = 'nm-big'; nm.textContent = p.name;
  pn.appendChild(face); pn.appendChild(nm);

  const ko = document.createElement('span'); ko.textContent = String(p.ko);

  const pups = document.createElement('span'); pups.className = 'pup-mini';
  /* Show last-round kos as a tiny badge — keeps the layout dense. */
  if(lastKos > 0){
    const badge = document.createElement('span');
    badge.style.cssText = 'background:var(--butter2)';
    badge.textContent = '+' + lastKos;
    pups.appendChild(badge);
  }

  const time = document.createElement('span'); time.textContent = lastTime;
  const sc = document.createElement('span');
  sc.innerHTML = isWinner ? `<b style="font-family:Fredoka;font-size:18px">${score}</b>` : String(score);

  row.append(pos, pn, ko, pups, time, sc);
  return row;
}

function formatTime(sec){
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
