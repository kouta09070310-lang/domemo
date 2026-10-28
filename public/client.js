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
for (const b of $('limitPicker').children) b.onclick = () => socket.emit('setHitLimit', Number(b.dataset.v));
for (const b of $('endPicker').children) b.onclick = () => socket.emit('setOption', { key: 'untilLast', value: b.dataset.v === 'last' });
for (const b of $('logPicker').children) b.onclick = () => socket.emit('setOption', { key: 'logMode', value: b.dataset.v });
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
    const lim = latest.hitLimit;
    for (const b of $('limitPicker').children) b.classList.toggle('on', Number(b.dataset.v) === lim);
    $('limitHint').textContent = members.length >= 4
      ? '4〜5人は公式ルールで1ターン1枚までです（この設定は2〜3人のときに効きます）'
      : lim === 0 ? '公式ルール：当たる限り続けて宣言できます' : `当たっても ${lim} 枚当てたら次の人に交代`;
    for (const b of $('endPicker').children) b.classList.toggle('on', (b.dataset.v === 'last') === latest.untilLast);
    for (const b of $('logPicker').children) b.classList.toggle('on', b.dataset.v === latest.logMode);
    $('logHint').textContent = (members.length === 2 ? '2人のときは終了条件はどちらでも同じです。' : '')
      + (latest.logMode === 'last' ? 'それより前の宣言は自分で覚えておく必要があります（終了後は全部見られます）' : '');
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
  const meP = game.players.find((p) => p.id === me);
  const n = game.players.length;
  if (game.phase === 'ended') {
    const w = game.players.find((p) => p.id === game.winner);
    if (!game.untilLast || n === 2) banner.textContent = w.id === me ? '🎉 あなたの勝ち！' : `${w.name} さんの勝ち`;
    else banner.textContent = meP.rank === 1 ? '🎉 あなたが1位！' : meP.rank === n ? `あなたは最下位…（${n}位）` : `あなたは ${meP.rank} 位`;
    banner.classList.add('win');
  } else if (meP.rank != null) {
    banner.textContent = `🎉 ${meP.rank}位で上がり！ 最下位が決まるまで観戦中（${turnName} さんの番）`;
    banner.classList.add('win');
  } else if (myTurn) {
    const left = game.maxHits == null ? '' : `（あと${game.maxHits - game.hitsThisTurn}枚）`;
    banner.textContent = game.continuing ? `正解！続けて宣言できます${left}` : 'あなたの番：自分にある数字を宣言';
    banner.classList.add('myturn');
  } else {
    banner.textContent = `${turnName} さんの番`;
  }

  // 他のプレイヤー（手番順に、自分の次の人から並べる）
  const idx = game.players.findIndex((p) => p.id === me);
  const others = game.players.slice(idx + 1).concat(game.players.slice(0, idx));
  $('others').replaceChildren(...others.map((p) => {
    const c = document.createElement('div');
    c.className = 'card' + (p.rank != null && game.phase === 'playing' ? ' player-out' : '');
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
    if (p.rank != null) {
      const r = document.createElement('span');
      r.className = 'rank-badge'; r.textContent = `${p.rank}位`;
      h.appendChild(r);
    }
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

  // 順位表（誰かが上がったら表示）
  $('ranking').classList.toggle('hidden', game.ranking.length === 0);
  $('rankList').replaceChildren(...game.ranking.map((id, i) => {
    const p = game.players.find((x) => x.id === id);
    const li = document.createElement('li');
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = `${i + 1}位`;
    const nm = document.createElement('span');
    nm.textContent = p.name + (p.id === me ? '（あなた）' : '');
    if (p.id === me) nm.className = 'me';
    li.append(pos, nm);
    return li;
  }));

  const logEntries = game.log.slice().reverse();
  const items = [];
  let lastTurn = null;
  for (const e of logEntries) {
    // 手番の区切り（直前の手番だけモードのとき、どこまでが今の手番か分かるように）
    if (lastTurn !== null && e.turn !== lastTurn) {
      const sep = document.createElement('li');
      sep.className = 'turn-sep'; sep.textContent = '―';
      items.push(sep);
    }
    lastTurn = e.turn;
    items.push(logItem(e));
  }
  $('logList').replaceChildren(...items);
  $('logSummary').textContent = game.logMode === 'last' && game.phase === 'playing' ? '宣言ログ（直前の1手番まで）' : '宣言ログ';
}

function logItem(e) {
    const li = document.createElement('li');
    if (e.finish) {
      li.className = 'finish';
      li.textContent = `${e.name}：全部当てて ${e.finish}位で上がり！`;
    } else if (e.pass) {
      li.textContent = `${e.name}：手番を終えた`;
    } else {
      li.textContent = `${e.name}：「${e.n}」 `;
      const r = document.createElement('span');
      r.className = e.hit ? 'hit' : 'miss';
      r.textContent = e.hit ? '正解' : 'はずれ';
      li.appendChild(r);
    }
    return li;
}
