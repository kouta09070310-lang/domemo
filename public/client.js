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
socket.on('update', (data) => {
  latest = data;
  // サーバーと端末の時計のずれ（タイマー表示用）
  if (data.game && data.game.serverNow) clockOffset = data.game.serverNow - Date.now();
  render();
});
let clockOffset = 0;

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
for (const b of $('timerPicker').children) b.onclick = () => socket.emit('setOption', { key: 'turnSec', value: Number(b.dataset.v) });
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
    document.body.classList.remove('my-turn');
    fxPrev = 'lobby'; // ロビーから開始した最初の手番は演出する
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
    for (const b of $('timerPicker').children) b.classList.toggle('on', Number(b.dataset.v) === latest.turnSec);
    $('timerHint').textContent = latest.turnSec
      ? `${latest.turnSec}秒以内に宣言しないと「はずれ」扱いで交代。リーチの人の番で半分を切ると…ざわ…`
      : '時間制限なし';
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
    const playingNow = game.phase === 'playing';
    c.className = 'card' + (p.rank != null && playingNow ? ' player-out' : '')
      + (p.id === game.turnId && playingNow ? ' is-turn' : '')
      + (isRiichi(p) && playingNow ? ' riichi' : '');
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
    } else if (isRiichi(p) && game.phase === 'playing') {
      h.appendChild(riichiBadge());
    }
    const row = document.createElement('div');
    row.className = 'tiles';
    fillTiles(row, p.tiles);
    if ((agariFlash.get(p.id) || 0) > Date.now()) c.classList.add('agari-flash');
    c.append(h, row);
    return c;
  }));

  fillTiles($('upTiles'), game.up.map((n) => ({ n, revealed: false })));
  $('upTiles').parentElement.querySelector('.row-head').classList.toggle('hidden', game.up.length === 0);
  $('upTiles').classList.toggle('hidden', game.up.length === 0);
  fillTiles($('downTiles'), game.down.map((n) => ({ n, revealed: false })));

  const mine = game.players[idx];
  fillTiles($('myTiles'), mine.tiles);
  const myRiichi = isRiichi(mine) && game.phase === 'playing';
  $('mine').classList.toggle('riichi', myRiichi);
  $('mine').classList.toggle('agari-flash', (agariFlash.get(mine.id) || 0) > Date.now());
  $('mine').classList.toggle('is-turn', myTurn);
  $('myHead').replaceChildren(document.createTextNode('あなたのタイル'), ...(myRiichi ? [riichiBadge()] : []));
  document.body.classList.toggle('my-turn', myTurn);
  playEffects(game, me);

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
    if (e.timeout) {
      li.className = 'timeout';
      li.textContent = `${e.name}：時間切れ（はずれ扱い）`;
    } else if (e.finish) {
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

// ===== 演出：自分の番・リーチ =====
// リーチ＝未公開タイルが残り1枚（あと1回当てれば上がり）。何枚当てたかは全員に見えているので新しい情報は漏れない
function isRiichi(p) {
  return p.rank == null && p.tiles.filter((t) => !t.revealed).length === 1;
}
function riichiBadge() {
  const b = document.createElement('span');
  b.className = 'riichi-badge';
  b.textContent = 'リーチ';
  return b;
}

// 前回の状態と比べて「変わった瞬間」だけ演出する（再接続・再読み込みでは鳴らさない）
let fxPrev = null;
function playEffects(game, me) {
  const sig = game.players.map((p) => p.id).join(',');
  const cur = {
    sig,
    turnNo: game.turnNo,
    myTurn: game.phase === 'playing' && game.turnId === me,
    riichi: new Set(game.players.filter(isRiichi).map((p) => p.id)),
    ranked: new Set(game.players.filter((p) => p.rank != null).map((p) => p.id)),
  };
  let prev = fxPrev;
  if (prev === 'lobby') prev = { sig, myTurn: false, riichi: new Set(), ranked: new Set() };
  fxPrev = cur;
  if (!prev || prev.sig !== sig) return;

  // 上がった人（全部当てた人。最下位は当て切っていないので除く）
  const finishers = game.players.filter((p) => cur.ranked.has(p.id) && !prev.ranked.has(p.id)
    && p.tiles.every((t) => t.revealed));
  if (finishers.length) {
    const p = finishers[0];
    agari(p, me, game);
    if (game.phase === 'ended') setTimeout(() => finale(game, me), 1900);
    else if (cur.myTurn && !prev.myTurn) setTimeout(turnPop, 1900);
    return;
  }
  if (game.phase !== 'playing') return;

  // 新しくリーチになった人
  const newRiichi = game.players.filter((p) => cur.riichi.has(p.id) && !prev.riichi.has(p.id));
  if (newRiichi.length) {
    const p = newRiichi[0];
    cutIn(p.id === me ? 'あなた' : p.name, 'リーチ！', 'riichi');
    bgm.duck(1800);
    sfx.riichi();
    voice.play('riichi');
    buzz([60, 40, 120]);
    // リーチ演出の後に自分の番の表示を出す
    if (cur.myTurn && !prev.myTurn) setTimeout(turnPop, 1500);
    return;
  }
  if (cur.myTurn && !prev.myTurn) turnPop();
}

function turnPop() {
  const el = $('turnPop');
  el.classList.remove('show');
  void el.offsetWidth; // アニメーションを最初から再生
  el.classList.add('show');
  sfx.turn();
  buzz(120);
}

// 上がり：金色のカットイン＋紙吹雪＋その人のタイルがきらめく
const agariFlash = new Map(); // id → 光らせ終わる時刻
function agari(p, me, game) {
  const who = p.id === me ? 'あなた' : p.name;
  cutIn(`${who} ・ ${p.rank}位`, '上がり！', p.rank === 1 ? 'gold' : 'silver');
  bgm.duck(2200);
  voice.play('agari', 0.25);
  sfx.agari(p.rank === 1);
  buzz(p.rank === 1 ? [80, 50, 80, 50, 200] : [80, 50, 120]);
  confetti(p.rank === 1 ? 90 : 35);
  agariFlash.set(p.id, Date.now() + 2600);
  setTimeout(render, 2700); // きらめき終了後に通常表示へ戻す
  render();
}

// 最下位が決まった（または1位で終了）ときの順位発表
function finale(game, me) {
  sfx.finale();
  const meP = game.players.find((p) => p.id === me);
  if (meP && meP.rank === 1) confetti(60);
}

function confetti(count) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#8e6bbf', '#3f86c7', '#2e9e8f', '#6aa538', '#d9a21b', '#e0742a', '#cc3d4f'];
  const layer = $('confetti');
  for (let i = 0; i < count; i++) {
    const d = document.createElement('i');
    d.style.left = Math.random() * 100 + 'vw';
    d.style.background = colors[i % colors.length];
    d.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
    d.style.animationDelay = Math.random() * 0.5 + 's';
    d.style.setProperty('--drift', (Math.random() * 160 - 80) + 'px');
    d.style.setProperty('--spin', (Math.random() * 1080 - 540) + 'deg');
    layer.appendChild(d);
    setTimeout(() => d.remove(), 4200);
  }
}

function cutIn(name, text, variant) {
  $('cutinName').textContent = `${name}`;
  $('cutinText').textContent = text;
  const el = $('cutin');
  el.dataset.variant = variant;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

// ===== 効果音（Web Audio でその場で合成。外部ファイルなし） =====
const MUTE_KEY = 'domemo-muted';
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}
let actx = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
// iPhone は一度タップしないと音が出せないので、最初のタップで音を有効にする
window.addEventListener('pointerdown', () => { if (!muted) audio(); }, { once: true });

// ===== 音量の一覧（1.0 = 元の音量）。リーチを基準に、ほかは控えめに =====
const LEVEL = {
  sfx: 0.6, // 効果音（ピコン・カチカチ・上がり・ファンファーレ）
  riichiSfx: 1.0, // リーチの「ドン」と和音（ちょうどいいとのことなので据え置き）
  voice: { riichi: 0.9, agari: 0.6, zawa1: 0.22, zawa2: 0.22 },
  bgm: 0.18, // BGM のふだんの音量
  bgmDuck: 0.3, // カットイン中は BGM をさらにこの割合まで下げる
};

function tone(freq, start, dur, { type = 'sine', vol = 0.18, to = null, level = LEVEL.sfx } = {}) {
  const a = audio();
  if (!a) return;
  vol *= level;
  const t0 = a.currentTime + start;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
const sfx = {
  // 残り5秒のカチカチ（最後の1秒は高い音）
  tick(sec) {
    if (muted) return;
    tone(sec === 1 ? 1760 : 1200, 0, 0.05, { type: 'square', vol: 0.05 });
  },
  // 上がり：明るいアルペジオ（1位はもう一段上まで）
  agari(first) {
    if (muted) return;
    const notes = first ? [523, 659, 784, 1047, 1319, 1568] : [523, 659, 784, 1047];
    notes.forEach((f, i) => tone(f, i * 0.09, 0.35, { type: 'triangle', vol: 0.16 }));
    tone(first ? 2093 : 1568, notes.length * 0.09, 0.6, { type: 'sine', vol: 0.1 });
  },
  // 順位発表：短いファンファーレ
  finale() {
    if (muted) return;
    [[523, 0], [523, 0.12], [523, 0.24], [659, 0.4], [784, 0.62]].forEach(([f, t]) =>
      tone(f, t, 0.18, { type: 'square', vol: 0.06 }));
    [523, 659, 784, 1047].forEach((f) => tone(f, 0.86, 1.0, { type: 'triangle', vol: 0.09 }));
  },
  // 自分の番：明るい2音「ピコン」
  turn() {
    if (muted) return;
    tone(988, 0, 0.12, { type: 'triangle' });
    tone(1319, 0.1, 0.22, { type: 'triangle' });
  },
  // リーチ：低い「ドン」→ 駆け上がる和音
  riichi() {
    if (muted) return;
    tone(110, 0, 0.35, { type: 'sine', vol: 0.4, to: 55, level: LEVEL.riichiSfx });
    tone(523, 0.18, 0.5, { type: 'sawtooth', vol: 0.06, level: LEVEL.riichiSfx });
    tone(659, 0.26, 0.5, { type: 'sawtooth', vol: 0.06, level: LEVEL.riichiSfx });
    tone(784, 0.34, 0.6, { type: 'sawtooth', vol: 0.06, level: LEVEL.riichiSfx });
    tone(1047, 0.42, 0.7, { type: 'triangle', vol: 0.12, level: LEVEL.riichiSfx });
  },
};

function renderMute() {
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
  $('muteBtn').setAttribute('aria-label', muted ? '音を出す' : '音を消す');
}
$('muteBtn').onclick = () => {
  muted = !muted;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch {}
  renderMute();
  bgm.sync();
  if (!muted) sfx.turn(); // 音量確認を兼ねて1回鳴らす
};
renderMute();

// ===== 声（public/voice/*.mp3 があれば再生。無ければ何もしない） =====
const voice = {
  buffers: {},
  loading: {},
  load(name) {
    const a = audio();
    if (!a || this.buffers[name] || this.loading[name]) return;
    this.loading[name] = fetch(`voice/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((b) => new Promise((ok, ng) => a.decodeAudioData(b, ok, ng)))
      .then((buf) => { this.buffers[name] = buf; })
      .catch(() => { this.buffers[name] = null; });
  },
  play(name, delay = 0.15) {
    if (muted) return;
    const a = audio();
    const buf = this.buffers[name];
    if (!a || !buf) return;
    const src = a.createBufferSource();
    const g = a.createGain();
    g.gain.value = LEVEL.voice[name] ?? 0.6;
    src.buffer = buf;
    src.connect(g).connect(a.destination);
    src.start(a.currentTime + delay); // 効果音の直後に声
  },
};
// 最初のタップで音を有効にするついでに、声を読み込んでおく
const VOICES = ['riichi', 'agari', 'zawa1', 'zawa2'];
window.addEventListener('pointerdown', () => VOICES.forEach((v) => voice.load(v)), { once: true });

// ===== BGM（端末ごとにオン/オフ。初期状態はオフ：開いた瞬間に鳴ると困る場面があるため） =====
const BGM_KEY = 'domemo-bgm';
const bgm = {
  el: null,
  on: false,
  gain: null, // 音量つまみ。iPhone は <audio> の volume を無視するため、こちらで音量を決める
  init() {
    try { this.on = localStorage.getItem(BGM_KEY) === '1'; } catch {}
    this.render();
  },
  ensure() {
    if (!this.el) {
      this.el = new Audio('bgm/main.mp3');
      this.el.loop = true;
      this.el.preload = 'none';
      const a = audio();
      if (a && a.createMediaElementSource) {
        this.gain = a.createGain();
        this.gain.gain.value = LEVEL.bgm;
        a.createMediaElementSource(this.el).connect(this.gain).connect(a.destination);
      } else {
        this.el.volume = LEVEL.bgm; // Web Audio が使えない古い端末向け
      }
    }
    return this.el;
  },
  // 🔊がオフ（全消音）のときや画面を閉じている間は止める
  sync() {
    const want = this.on && !muted && document.visibilityState === 'visible';
    if (want) { audio(); const p = this.ensure().play(); if (p) p.catch(() => {}); } // audio() で一時停止中の音声を再開
    else if (this.el) this.el.pause();
    this.render();
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem(BGM_KEY, this.on ? '1' : '0'); } catch {}
    this.sync();
    if (this.on && muted) toast('🔇（全体の消音）がオンのため鳴りません');
  },
  // カットインや声の間だけ音量を下げる
  duck(ms) {
    if (!this.el || this.el.paused) return;
    this.setLevel(LEVEL.bgm * LEVEL.bgmDuck);
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => this.setLevel(LEVEL.bgm), ms);
  },
  setLevel(v) {
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.gain.context.currentTime, 0.15); // なめらかに変える
    else if (this.el) this.el.volume = v;
  },
  render() {
    const b = $('bgmBtn');
    b.classList.toggle('off', !this.on);
    b.setAttribute('aria-label', this.on ? 'BGMを止める' : 'BGMを流す');
  },
};
$('bgmBtn').onclick = () => bgm.toggle();
document.addEventListener('visibilitychange', () => bgm.sync());
// iPhone は操作なしでは再生できないので、BGMオンの人は最初のタップで流し始める
window.addEventListener('pointerdown', () => bgm.sync(), { once: true });
bgm.init();

// ===== タイマー表示・残り5秒のカチカチ・リーチ中に半分を切ったら「ざわ…ざわ…」 =====
const tick = { turnNo: null, lastSec: null, zawaTurn: null, aboveHalf: false };
setInterval(updateTimer, 200);
function updateTimer() {
  const g = latest && latest.game;
  const el = $('timer');
  if (!g || g.phase !== 'playing' || !g.turnSec || g.deadline == null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const total = g.turnSec * 1000;
  const left = Math.max(0, g.deadline - (Date.now() + clockOffset));
  const sec = Math.ceil(left / 1000);
  $('timerFill').style.width = (left / total) * 100 + '%';
  const turnP = g.players.find((p) => p.id === g.turnId);
  const mine = g.turnId === latest.me;
  $('timerText').textContent = `${mine ? 'あなた' : turnP.name}の残り ${sec}秒`;
  el.classList.toggle('half', left <= total / 2 && sec > 5);
  el.classList.toggle('danger', sec <= 5);

  if (tick.turnNo !== g.turnNo) {
    // 手番が変わった：この手番の開始時点で半分より上にいたかを覚える（再読み込み直後に鳴らさないため）
    tick.turnNo = g.turnNo;
    tick.lastSec = sec;
    tick.aboveHalf = left > total / 2;
    return;
  }
  // 残り5秒からは手番の人の端末だけカチカチ（同じ部屋に何台もあるとうるさいため）
  if (mine && sec !== tick.lastSec && sec <= 5 && sec >= 1) sfx.tick(sec);
  tick.lastSec = sec;

  // リーチの人の番で残り半分を切った瞬間：全員の端末で「ざわ…ざわ…」
  if (left > total / 2) tick.aboveHalf = true;
  else if (tick.aboveHalf && tick.zawaTurn !== g.turnNo && isRiichi(turnP)) {
    tick.zawaTurn = g.turnNo;
    zawa();
  }
}

function zawa() {
  voice.play(Math.random() < 0.5 ? 'zawa1' : 'zawa2', 0);
  bgm.duck(5200);
  const layer = $('zawa');
  layer.replaceChildren();
  // 画面のあちこちに「ざわ…」を時間差で出す
  const spots = [[6, 14], [58, 20], [16, 40], [62, 48], [8, 66], [52, 76], [30, 88]];
  spots.forEach(([x, y], i) => {
    const sp = document.createElement('span');
    sp.textContent = 'ざわ…';
    sp.style.left = x + (Math.random() * 8 - 4) + 'vw';
    sp.style.top = y + (Math.random() * 4 - 2) + 'vh';
    sp.style.fontSize = 30 + Math.random() * 22 + 'px';
    sp.style.animationDelay = i * 0.35 + 's';
    layer.appendChild(sp);
  });
  setTimeout(() => layer.replaceChildren(), 7500);
}
