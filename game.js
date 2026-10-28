// ドメモのルールロジック（通信に依存しない純粋な処理）
'use strict';

// 人数ごとの配り方（公式ルール）
//   hand: 1人あたりの枚数 / down: 伏せたまま使わない枚数 / up: 場に公開する枚数
//   multi: 正解したら続けて宣言できるか（2〜3人のみ可）
const SETUP = {
  2: { hand: 7, down: 7, up: 7, multi: true },
  3: { hand: 7, down: 7, up: 0, multi: true },
  4: { hand: 5, down: 4, up: 4, multi: false },
  5: { hand: 4, down: 4, up: 4, multi: false },
};

// 1〜7 のタイルを「数字 n が n 枚」で計28枚作る
function makeDeck() {
  const deck = [];
  for (let n = 1; n <= 7; n++) for (let i = 0; i < n; i++) deck.push(n);
  return deck;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 1ターンに当てられる枚数の設定値（0 = 無制限＝公式ルール）
const HIT_LIMITS = [0, 1, 2, 3];

// 宣言ログの見せ方：all = 全部 / last = 直前の手番と今の手番だけ
const LOG_MODES = ['all', 'last'];

// 1手番の持ち時間（秒）。0 = なし
const TURN_SECS = [0, 15, 30, 60];

// ゲーム開始。players: [{id, name}]（参加順）。手番順はランダムに並べ替える
// opts.hitLimit: 1ターンに当てられる最大枚数（0 = 無制限）。4〜5人は公式どおり常に1
// opts.untilLast: true = 最下位が決まるまで続ける / false = 1位が出たら終了
// opts.logMode: 宣言ログの見せ方（LOG_MODES）
// opts.turnSec: 1手番の持ち時間（TURN_SECS）。正解して続けて宣言するときは残り時間を引き継ぐ
// opts.now: 現在時刻（テスト用に差し替えられるように）
function createGame(players, rng = Math.random, opts = {}) {
  const base = SETUP[players.length];
  if (!base) throw new Error('2〜5人で遊んでください');
  const limit = HIT_LIMITS.includes(opts.hitLimit) ? opts.hitLimit : 0;
  const setup = {
    ...base,
    maxHits: base.multi ? (limit || Infinity) : 1,
    untilLast: opts.untilLast !== false,
    logMode: LOG_MODES.includes(opts.logMode) ? opts.logMode : 'all',
    turnSec: TURN_SECS.includes(opts.turnSec) ? opts.turnSec : 0,
  };
  const deck = shuffle(makeDeck(), rng);
  const order = shuffle(players, rng);
  let k = 0;
  const take = (cnt) => deck.slice(k, (k += cnt)).sort((a, b) => a - b);

  const state = {
    setup,
    players: order.map((p) => ({
      id: p.id,
      name: p.name,
      tiles: take(setup.hand).map((n) => ({ n, revealed: false })),
      rank: null, // 上がった順位（まだなら null）
    })),
    up: take(setup.up),
    down: take(setup.down),
    turn: 0, // players 配列内の手番プレイヤーの添字
    continuing: false, // 正解直後で続けて宣言できる状態か
    hitsThisTurn: 0, // この手番で当てた枚数
    turnNo: 1, // 通し番号の手番（ログの「直前の手番」判定に使う）
    phase: 'playing',
    winner: null, // 1位の id
    ranking: [], // 上がった順の id（最下位も最後に入る）
    deadline: null, // 今の手番の締め切り時刻（ms）。持ち時間なしなら null
    log: [],
  };
  startClock(state, opts.now ?? Date.now());
  return state;
}

function startClock(state, now) {
  state.deadline = state.setup.turnSec ? now + state.setup.turnSec * 1000 : null;
}

// 次の「まだ上がっていない人」に手番を回す
function nextTurn(state, now = Date.now()) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const t = (state.turn + i) % n;
    if (state.players[t].rank == null) { state.turn = t; break; }
  }
  state.continuing = false;
  state.hitsThisTurn = 0;
  state.turnNo++;
  startClock(state, now);
}

// 時間切れの処理：締め切りを過ぎていたら「はずれ」扱いで次の人へ。戻り値は処理したかどうか
function timeout(state, now = Date.now()) {
  if (state.phase !== 'playing' || state.deadline == null || now < state.deadline) return false;
  const p = state.players[state.turn];
  state.log.push({ turn: state.turnNo, name: p.name, timeout: true });
  nextTurn(state, now);
  return true;
}

function finishGame(state) {
  state.phase = 'ended';
  state.winner = state.ranking[0] || null;
}

// 数字の宣言。戻り値 {ok, error?, hit?}
function guess(state, playerId, n, now = Date.now()) {
  if (state.phase !== 'playing') return { ok: false, error: 'ゲームは終了しています' };
  if (state.deadline != null && now >= state.deadline) return { ok: false, error: '時間切れです' };
  const p = state.players[state.turn];
  if (p.id !== playerId) return { ok: false, error: 'あなたの番ではありません' };
  if (!Number.isInteger(n) || n < 1 || n > 7) return { ok: false, error: '1〜7で宣言してください' };

  const tile = p.tiles.find((t) => !t.revealed && t.n === n);
  const hit = !!tile;
  state.log.push({ turn: state.turnNo, name: p.name, n, hit });

  if (hit) {
    tile.revealed = true; // 同じ数字が複数あっても表にするのは1枚だけ
    if (p.tiles.every((t) => t.revealed)) {
      // 上がり：順位を付けて抜ける
      p.rank = state.ranking.length + 1;
      state.ranking.push(p.id);
      state.log.push({ turn: state.turnNo, name: p.name, finish: p.rank });
      const left = state.players.filter((x) => x.rank == null);
      if (!state.setup.untilLast || left.length <= 1) {
        // 残り1人ならその人が最下位
        for (const x of left) { x.rank = state.ranking.length + 1; state.ranking.push(x.id); }
        finishGame(state);
        return { ok: true, hit, finished: p.rank };
      }
      nextTurn(state, now);
      return { ok: true, hit, finished: p.rank };
    }
    state.hitsThisTurn++;
    if (state.hitsThisTurn < state.setup.maxHits) {
      state.continuing = true; // 上限に達していなければもう一度宣言できる
    } else {
      nextTurn(state, now); // 上限に達したら交代
    }
  } else {
    nextTurn(state, now);
  }
  return { ok: true, hit };
}

// 正解後の連続宣言をやめて手番を渡す（2〜3人のみ）
function pass(state, playerId, now = Date.now()) {
  if (state.phase !== 'playing') return { ok: false, error: 'ゲームは終了しています' };
  if (state.players[state.turn].id !== playerId) return { ok: false, error: 'あなたの番ではありません' };
  if (!state.continuing) return { ok: false, error: '今は手番を終えられません' };
  state.log.push({ turn: state.turnNo, name: state.players[state.turn].name, pass: true });
  nextTurn(state, now);
  return { ok: true };
}

// ログの見せ方に応じて絞り込む。last のときは「直前の手番」と「今の手番」の分だけ
// （画面で隠すのではなく、送るデータ自体から消すので覗いても見えない）
function visibleLog(state) {
  if (state.phase === 'ended' || state.setup.logMode === 'all') return state.log.slice(-60);
  return state.log.filter((e) => e.turn >= state.turnNo - 1);
}

// プレイヤー別に「見てよい情報だけ」を作る（サーバー権威型の要）
// 自分の未公開タイルの数字は絶対に含めない。伏せタイルは終了時のみ公開
function viewFor(state, playerId) {
  const ended = state.phase === 'ended';
  return {
    phase: state.phase,
    me: playerId,
    multi: state.setup.multi,
    maxHits: Number.isFinite(state.setup.maxHits) ? state.setup.maxHits : null, // null = 無制限
    hitsThisTurn: state.hitsThisTurn,
    turnId: state.players[state.turn].id,
    continuing: state.continuing,
    winner: state.winner,
    untilLast: state.setup.untilLast,
    logMode: state.setup.logMode,
    turnNo: state.turnNo,
    turnSec: state.setup.turnSec,
    deadline: state.phase === 'playing' ? state.deadline : null,
    serverNow: Date.now(), // 端末との時計のずれを補正するため
    ranking: state.ranking.slice(),
    players: state.players.map((p) => {
      let tiles = p.tiles.map((t) => ({
        n: p.id === playerId && !t.revealed && !ended ? null : t.n,
        revealed: t.revealed,
      }));
      // 自分の手札は昇順で保存しているため、位置から未公開の数字の大小が推測できてしまう。
      // 自分の画面では「当てたもの → 未公開」の順に並べて位置の手がかりを消す
      if (p.id === playerId && !ended) {
        tiles = tiles.filter((t) => t.revealed).sort((a, b) => a.n - b.n)
          .concat(tiles.filter((t) => !t.revealed));
      }
      return { id: p.id, name: p.name, rank: p.rank, tiles };
    }),
    up: state.up.slice(),
    down: ended ? state.down.slice() : state.down.map(() => null),
    log: visibleLog(state),
  };
}

module.exports = { SETUP, HIT_LIMITS, LOG_MODES, TURN_SECS, timeout, makeDeck, createGame, guess, pass, viewFor };
