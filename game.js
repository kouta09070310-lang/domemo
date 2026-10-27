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

// ゲーム開始。players: [{id, name}]（参加順）。手番順はランダムに並べ替える
// opts.hitLimit: 1ターンに当てられる最大枚数（0 = 無制限）。4〜5人は公式どおり常に1
function createGame(players, rng = Math.random, opts = {}) {
  const base = SETUP[players.length];
  if (!base) throw new Error('2〜5人で遊んでください');
  const limit = HIT_LIMITS.includes(opts.hitLimit) ? opts.hitLimit : 0;
  const setup = { ...base, maxHits: base.multi ? (limit || Infinity) : 1 };
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
    })),
    up: take(setup.up),
    down: take(setup.down),
    turn: 0, // players 配列内の手番プレイヤーの添字
    continuing: false, // 正解直後で続けて宣言できる状態か
    hitsThisTurn: 0, // この手番で当てた枚数
    phase: 'playing',
    winner: null,
    log: [],
  };
  return state;
}

function nextTurn(state) {
  state.turn = (state.turn + 1) % state.players.length;
  state.continuing = false;
  state.hitsThisTurn = 0;
}

// 数字の宣言。戻り値 {ok, error?, hit?}
function guess(state, playerId, n) {
  if (state.phase !== 'playing') return { ok: false, error: 'ゲームは終了しています' };
  const p = state.players[state.turn];
  if (p.id !== playerId) return { ok: false, error: 'あなたの番ではありません' };
  if (!Number.isInteger(n) || n < 1 || n > 7) return { ok: false, error: '1〜7で宣言してください' };

  const tile = p.tiles.find((t) => !t.revealed && t.n === n);
  const hit = !!tile;
  state.log.push({ name: p.name, n, hit });

  if (hit) {
    tile.revealed = true; // 同じ数字が複数あっても表にするのは1枚だけ
    if (p.tiles.every((t) => t.revealed)) {
      state.phase = 'ended';
      state.winner = p.id;
      return { ok: true, hit };
    }
    state.hitsThisTurn++;
    if (state.hitsThisTurn < state.setup.maxHits) {
      state.continuing = true; // 上限に達していなければもう一度宣言できる
    } else {
      nextTurn(state); // 上限に達したら交代
    }
  } else {
    nextTurn(state);
  }
  return { ok: true, hit };
}

// 正解後の連続宣言をやめて手番を渡す（2〜3人のみ）
function pass(state, playerId) {
  if (state.phase !== 'playing') return { ok: false, error: 'ゲームは終了しています' };
  if (state.players[state.turn].id !== playerId) return { ok: false, error: 'あなたの番ではありません' };
  if (!state.continuing) return { ok: false, error: '今は手番を終えられません' };
  state.log.push({ name: state.players[state.turn].name, pass: true });
  nextTurn(state);
  return { ok: true };
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
      return { id: p.id, name: p.name, tiles };
    }),
    up: state.up.slice(),
    down: ended ? state.down.slice() : state.down.map(() => null),
    log: state.log.slice(-30),
  };
}

module.exports = { SETUP, HIT_LIMITS, makeDeck, createGame, guess, pass, viewFor };
