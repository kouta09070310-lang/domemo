// ドメモ サーバー：部屋コード付きリンクで複数グループが同時に遊べる
// ・クラウド（Render など）：公開URLを共有して遊ぶ
// ・LAN：Mac で npm start → 同じ Wi-Fi の端末から参加（従来どおり）
'use strict';
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const game = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const LOBBY_TIMEOUT_MS = 60 * 1000; // ロビーで切断したまま戻らない人を外すまで
const EMPTY_ROOM_MS = 30 * 60 * 1000; // 全員いなくなった部屋を消すまで
const MAX_ROOMS = 500; // いたずら対策の上限
const ROOM_RE = /^[A-Z0-9]{4,8}$/; // 部屋コード：英大文字と数字 4〜8 文字

// LAN の IPv4 アドレスを探す（Mac の Wi-Fi は通常 en0）
function lanAddress() {
  const cands = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) cands.push({ name, address: a.address });
  }
  cands.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : 0));
  return cands[0] ? cands[0].address : 'localhost';
}

// 共有用のベースURL。Render は RENDER_EXTERNAL_URL を自動で設定する
const BASE_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanAddress()}:${PORT}`).replace(/\/$/, '');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 部屋リンクとQR（部屋コードは形式チェック済みのものだけ受け付ける）
app.get('/info', async (req, res) => {
  const room = String(req.query.room || '').toUpperCase();
  if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });
  const url = `${BASE_URL}/?room=${room}`;
  res.json({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) });
});

const server = http.createServer(app);
const io = new Server(server);

// rooms: code → { code, members: [{token, name, socketId, online, leaveTimer}], state, emptyTimer }
const rooms = new Map();

function getOrCreateRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    // 部屋の設定：hitLimit 0 = 無制限（公式）/ untilLast true = 最下位まで / logMode 'all' = ログ全部
    r = { code, members: [], state: null, emptyTimer: null, hitLimit: 0, untilLast: true, logMode: 'all' };
    rooms.set(code, r);
  }
  return r;
}

// 接続中の人が0になったら、一定時間後に部屋ごと消す
function scheduleCleanup(r) {
  clearTimeout(r.emptyTimer);
  if (r.members.some((m) => m.online)) return;
  r.emptyTimer = setTimeout(() => {
    if (!r.members.some((m) => m.online)) rooms.delete(r.code);
  }, EMPTY_ROOM_MS);
}

const idOf = (m) => m.token.slice(0, 8); // 公開用ID（トークン本体は他人に送らない）
const playing = (r) => r.state && r.state.phase === 'playing';
const inGame = (r, m) => r.state && r.state.players.some((p) => p.id === idOf(m));

function broadcast(r) {
  const members = r.members.map((m) => ({ id: idOf(m), name: m.name, online: m.online }));
  for (const m of r.members) {
    if (!m.socketId) continue;
    io.to(m.socketId).emit('update', {
      room: r.code,
      hitLimit: r.hitLimit,
      untilLast: r.untilLast,
      logMode: r.logMode,
      me: idOf(m),
      members,
      game: r.state ? game.viewFor(r.state, idOf(m)) : null,
    });
  }
}

io.on('connection', (socket) => {
  let room = null;
  let member = null;

  // 部屋に入る。token があれば同じ席に戻る（画面が消えた・再読み込みした場合）
  socket.on('enter', ({ room: code, token } = {}) => {
    code = String(code || '').toUpperCase();
    if (!ROOM_RE.test(code)) return socket.emit('badRoom');
    const r = getOrCreateRoom(code);
    if (!r) return socket.emit('errorMsg', '混み合っています。しばらくしてからお試しください');
    room = r;
    clearTimeout(r.emptyTimer);
    const m = token && r.members.find((x) => x.token === token);
    if (m) {
      member = m;
      clearTimeout(m.leaveTimer);
      m.socketId = socket.id;
      m.online = true;
      broadcast(r);
    } else {
      socket.emit('needName', { room: code, playing: !!playing(r), count: r.members.length });
      scheduleCleanup(r);
    }
  });

  socket.on('join', (rawName) => {
    const r = room;
    if (!r || member) return;
    const name = String(rawName || '').trim().slice(0, 12);
    if (!name) return socket.emit('errorMsg', '名前を入れてください');
    if (playing(r)) return socket.emit('errorMsg', 'ゲーム中です。終わるまで待ってください');
    if (r.members.length >= 5) return socket.emit('errorMsg', '満員です（最大5人）');
    if (r.members.some((m) => m.name === name)) return socket.emit('errorMsg', 'その名前は使われています');
    member = { token: crypto.randomBytes(16).toString('hex'), name, socketId: socket.id, online: true };
    r.members.push(member);
    clearTimeout(r.emptyTimer);
    socket.emit('joined', { room: r.code, token: member.token });
    broadcast(r);
  });

  socket.on('start', () => {
    const r = room;
    if (!r || !member || playing(r)) return;
    const n = r.members.length;
    if (n < 2 || n > 5) return socket.emit('errorMsg', '2〜5人で開始できます');
    r.state = game.createGame(r.members.map((m) => ({ id: idOf(m), name: m.name })), Math.random, {
      hitLimit: r.hitLimit, untilLast: r.untilLast, logMode: r.logMode,
    });
    broadcast(r);
  });

  // 部屋の設定：1ターンに当てられる枚数（ロビーでのみ変更可、全員に反映）
  socket.on('setHitLimit', (v) => {
    const r = room;
    if (!r || !member || r.state) return;
    v = Number(v);
    if (!game.HIT_LIMITS.includes(v)) return;
    r.hitLimit = v;
    broadcast(r);
  });

  // 終了条件とログ表示の設定（ロビーでのみ変更可、全員に反映）
  socket.on('setOption', ({ key, value } = {}) => {
    const r = room;
    if (!r || !member || r.state) return;
    if (key === 'untilLast' && typeof value === 'boolean') r.untilLast = value;
    else if (key === 'logMode' && game.LOG_MODES.includes(value)) r.logMode = value;
    else return;
    broadcast(r);
  });

  socket.on('guess', (n) => {
    const r = room;
    if (!r || !member || !r.state) return;
    const res = game.guess(r.state, idOf(member), Number(n));
    if (!res.ok) return socket.emit('errorMsg', res.error);
    broadcast(r);
  });

  socket.on('pass', () => {
    const r = room;
    if (!r || !member || !r.state) return;
    const res = game.pass(r.state, idOf(member));
    if (!res.ok) return socket.emit('errorMsg', res.error);
    broadcast(r);
  });

  // 終了後にロビーへ戻る（メンバー変更や再戦用）
  socket.on('toLobby', () => {
    const r = room;
    if (!r || !member || !r.state || r.state.phase !== 'ended') return;
    r.state = null;
    r.members = r.members.filter((m) => m.online); // ゲーム中に切断していた人を外す
    broadcast(r);
  });

  socket.on('leave', () => {
    const r = room;
    if (!r || !member) return;
    if (playing(r) && inGame(r, member)) return socket.emit('errorMsg', 'ゲーム中は退出できません');
    r.members = r.members.filter((m) => m !== member);
    member = null;
    socket.emit('left');
    broadcast(r);
    scheduleCleanup(r);
  });

  socket.on('disconnect', () => {
    const r = room;
    if (!r) return;
    if (member && member.socketId === socket.id) {
      const m = member;
      m.online = false;
      m.socketId = null;
      // ゲーム中は席を保持。ロビーでは一定時間戻らなければ外す
      if (!(playing(r) && inGame(r, m))) {
        m.leaveTimer = setTimeout(() => {
          if (m.online || (playing(r) && inGame(r, m))) return;
          r.members = r.members.filter((x) => x !== m);
          broadcast(r);
        }, LOBBY_TIMEOUT_MS);
      }
      broadcast(r);
    }
    scheduleCleanup(r);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n=== ドメモ サーバー起動 ===');
  console.log(`URL: ${BASE_URL}`);
  if (!process.env.RENDER_EXTERNAL_URL && !process.env.PUBLIC_URL) {
    console.log('同じWi-Fiのスマホで下のQRを読み取ってください\n');
    console.log(await QRCode.toString(BASE_URL, { type: 'terminal', small: true }));
    console.log('終了するには Ctrl + C');
  }
});
