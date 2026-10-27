// ドメモ クライアント：サーバーから届いた「自分用の情報」を描画するだけ
'use strict';
const socket = io();
const $ = (id) => document.getElementById(id);
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい 0/O/1/I は除外

// 席に戻るためのトークンは部屋ごとに端末へ保存
const tokenKey = (r) => 'domemo-token-' + r;
function loadToken(r) { try { return localStorage.getItem(tokenKey(r)); } catch { return null; } }
function saveToken(r, t) { try { t ? localStorage.setItem(tokenKey(r), t) : localStorage.removeItem(tokenKey(r)); } catch {} }

let room = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
if (!ROOM_RE.test(room)) room = '';
let latest = null;
let qrRoom = null;

function show(screen) {
  $('waking').classList.add('hidden');
  for (const s of ['home', 'join', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== screen);
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2500);
}

function setUrl(code) {
  const url = code ? `${location.pathname}?room=${code}` : location.pathname;
  history.replaceState(null, '', url);
}

function enterRoom(code) {
  room = code;
  latest = null;
  setUrl(code);
  socket.emit('enter', { room, token: loadToken(room) });
}

function goHome() {
  room = '';
  latest = null;
  setUrl('');
  show('home');
}

// 接続（再接続含む）のたびに、部屋に入り直して同じ席に戻る
socket.on('connect', () => {
  if (room) socket.emit('enter', { room, token: loadToken(room) });
  else show('home');
});
socket.on('needName', (info) => {
  latest = null;
  $('joinRoom').textContent = info.room;
  $('joinNote').textContent = info.playing ? 'この部屋はゲーム中です。終わると参加できます' : `いま ${info.count} 人が参加中`;
  show('join');
});
socket.on('badRoom', () => { toast('部屋コードは英数字4〜8文字です'); goHome(); });
socket.on('joined', (d) => saveToken(d.room, d.token));
socket.on('left', () => { saveToken(room, null); goHome(); });
socket.on('errorMsg', toast);
socket.on('update', (data) => { latest = data; render(); });

$('createBtn').onclick = () => {
  let code = '';
  const rnd = crypto.getRandomValues(new Uint32Array(4));
  for (const v of rnd) code += CODE_CHARS[v % CODE_CHARS.length];
  enterRoom(code);
};
$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!ROOM_RE.test(code)) return toast('部屋コードは英数字4〜8文字です');
  enterRoom(code);
});
$('homeBtn').onclick = goHome;
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('join', $('nameInput').value);
});
$('startBtn').onclick = () => socket.emit('start');
$('leaveBtn').onclick = () => socket.emit('leave');
$('passBtn').onclick = () => socket.emit('pass');
$('lobbyBtn').onclick = () => socket.emit('toLobby');

// 招待：スマホは共有シート、PCはリンクをコピー
$('shareBtn').onclick = async () => {
  const url = $('joinUrl').textContent;
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: 'ドメモやろう', text: `ドメモの部屋 ${room} に参加してね`, url }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました'); }
  catch { toast('リンクを長押しでコピーしてください'); }
};

function loadQr() {
  if (qrRoom === room) return;
  qrRoom = room;
  fetch('/info?room=' + room).then((r) => r.json()).then((info) => {
    if (info.error) return;
    $('qrImg').src = info.qr;
    $('joinUrl').textContent = info.url;
  });
}

// 数字ボタン 1〜7
for (let n = 1; n <= 7; n++) {
  const b = document.createElement('button');
  b.textContent = n;
  b.style.background = `var(--n${n})`;
  b.onclick = () => socket.emit('guess', n);
  $('numPad').appendChild(b);
}

function tileEl(t) {
  const d = document.createElement('div');
  d.className = 'tile ' + (t.n == null ? 'unknown' : 'n' + t.n) + (t.revealed ? ' revealed' : '');
  d.textContent = t.n == null ? '?' : t.n;
  return d;
}

function fillTiles(el, tiles) {
  el.replaceChildren(...tiles.map(tileEl));
}

function render() {
  if (!latest) return;
  const { me, members, game } = latest;

  if (!game) {
    show('lobby');
    $('lobbyRoom').textContent = latest.room;
    loadQr();
    $('memberCount').textContent = `${members.length}/5`;
    $('memberList').replaceChildren(...members.map((m) => {
      const li = document.createElement('li');
      li.textContent = m.name + (m.id === me ? '（あなた）' : '');
      if (!m.online) {
        const s = document.createElement('span');
        s.className = 'off'; s.textContent = '接続待ち';
        li.appendChild(s);
      }
      return li;
    }));
    const ok = members.length >= 2 && members.length <= 5;
    $('startBtn').disabled = !ok;
    $('startHint').textContent = ok ? '全員そろったら誰が押してもOK' : '2〜5人で開始できます';
    return;
  }

  show('game');
  const myTurn = game.phase === 'playing' && game.turnId === me;
  const turnName = game.players.find((p) => p.id === game.turnId)?.name;
  const banner = $('banner');
  banner.className = 'banner';
  if (game.phase === 'ended') {
    const w = game.players.find((p) => p.id === game.winner);
    banner.textContent = w.id === me ? '🎉 あなたの勝ち！' : `${w.name} さんの勝ち`;
    banner.classList.add('win');
  } else if (myTurn) {
    banner.textContent = game.continuing ? '正解！続けて宣言できます' : 'あなたの番：自分にある数字を宣言';
    banner.classList.add('myturn');
  } else {
    banner.textContent = `${turnName} さんの番`;
  }

  // 他のプレイヤー（手番順に、自分の次の人から並べる）
  const idx = game.players.findIndex((p) => p.id === me);
  const others = game.players.slice(idx + 1).concat(game.players.slice(0, idx));
  $('others').replaceChildren(...others.map((p) => {
    const c = document.createElement('div');
    c.className = 'card';
    const h = document.createElement('div');
    h.className = 'player-name';
    if (p.id === game.turnId && game.phase === 'playing') {
      const dot = document.createElement('span'); dot.className = 'turn-dot'; h.appendChild(dot);
    }
    h.appendChild(document.createTextNode(p.name));
    const done = p.tiles.filter((t) => t.revealed).length;
    const s = document.createElement('span');
    s.className = 'done'; s.textContent = `${done}/${p.tiles.length} 正解`;
    h.appendChild(s);
    const row = document.createElement('div');
    row.className = 'tiles';
    fillTiles(row, p.tiles);
    c.append(h, row);
    return c;
  }));

  fillTiles($('upTiles'), game.up.map((n) => ({ n, revealed: false })));
  $('upTiles').parentElement.querySelector('.row-head').classList.toggle('hidden', game.up.length === 0);
  $('upTiles').classList.toggle('hidden', game.up.length === 0);
  fillTiles($('downTiles'), game.down.map((n) => ({ n, revealed: false })));

  const mine = game.players[idx];
  fillTiles($('myTiles'), mine.tiles);

  // 操作欄
  const playing = game.phase === 'playing';
  $('controls').classList.toggle('hidden', !playing);
  $('controls').classList.toggle('active', myTurn);
  $('endControls').classList.toggle('hidden', playing);
  for (const b of $('numPad').children) b.disabled = !myTurn;
  $('passBtn').classList.toggle('hidden', !(myTurn && game.continuing));

  $('logList').replaceChildren(...game.log.slice().reverse().map((e) => {
    const li = document.createElement('li');
    if (e.pass) {
      li.textContent = `${e.name}：手番を終えた`;
    } else {
      li.textContent = `${e.name}：「${e.n}」 `;
      const r = document.createElement('span');
      r.className = e.hit ? 'hit' : 'miss';
      r.textContent = e.hit ? '正解' : 'はずれ';
      li.appendChild(r);
    }
    return li;
  }));
}
