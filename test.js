// game.js の動作確認（npm test で実行）
'use strict';
const assert = require('assert');
const g = require('./game');

const mk = (k) => Array.from({ length: k }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));

// 1. 人数ごとの配牌枚数と、28枚がちょうど配られていること
for (const k of [2, 3, 4, 5]) {
  const s = g.createGame(mk(k));
  const su = g.SETUP[k];
  s.players.forEach((p) => assert.strictEqual(p.tiles.length, su.hand));
  assert.strictEqual(s.up.length, su.up);
  assert.strictEqual(s.down.length, su.down);
  const all = [...s.players.flatMap((p) => p.tiles.map((t) => t.n)), ...s.up, ...s.down].sort();
  assert.deepStrictEqual(all, g.makeDeck().sort());
}

// 2. 自分の未公開タイルは viewFor に含まれない／他人のは見える／伏せは見えない
{
  const s = g.createGame(mk(4));
  const me = s.players[0].id;
  const v = g.viewFor(s, me);
  assert(v.players[0].tiles.every((t) => t.n === null));
  assert(v.players.slice(1).every((p) => p.tiles.every((t) => t.n !== null)));
  assert(v.down.every((n) => n === null));
  // JSON 全体に自分の数字の手がかりが残っていないこと（伏せ・自分以外の数字の合計と照合）
  const visible = [...v.players.flatMap((p) => p.tiles.map((t) => t.n)).filter((n) => n), ...v.up];
  assert.strictEqual(visible.length, 28 - 5 - 4);
}

// 手番プレイヤーの「持っている数字」「持っていない数字」を取るヘルパー
const cur = (s) => s.players[s.turn];
const hasN = (p) => p.tiles.find((t) => !t.revealed).n;
const missN = (p) => [1, 2, 3, 4, 5, 6, 7].find((n) => !p.tiles.some((t) => !t.revealed && t.n === n));

// 3. 4〜5人：正解しても手番が移る
{
  const s = g.createGame(mk(4));
  const p = cur(s);
  const r = g.guess(s, p.id, hasN(p));
  assert(r.ok && r.hit);
  assert.notStrictEqual(cur(s).id, p.id);
  assert.strictEqual(p.tiles.filter((t) => t.revealed).length, 1);
}

// 4. 2〜3人：正解なら続けて宣言でき、パスで手番が移る
for (const k of [2, 3]) {
  const s = g.createGame(mk(k));
  const p = cur(s);
  g.guess(s, p.id, hasN(p));
  assert.strictEqual(cur(s).id, p.id);
  assert(s.continuing);
  assert(g.pass(s, p.id).ok);
  assert.notStrictEqual(cur(s).id, p.id);
  assert(!g.pass(s, cur(s).id).ok); // 正解前はパス不可
}

// 5. はずれで手番が移る／手番外・範囲外は拒否
{
  const s = g.createGame(mk(3));
  const p = cur(s);
  const other = s.players.find((x) => x !== p);
  assert(!g.guess(s, other.id, 1).ok);
  assert(!g.guess(s, p.id, 8).ok);
  const m = missN(p);
  if (m) {
    const r = g.guess(s, p.id, m);
    assert(r.ok && !r.hit);
    assert.notStrictEqual(cur(s).id, p.id);
  }
}

// 6. 同じ数字が複数あっても、1回の正解で表になるのは1枚
{
  let s;
  do { s = g.createGame(mk(2)); } while (!cur(s).tiles.some((t, i, a) => a.findIndex((x) => x.n === t.n) !== i));
  const p = cur(s);
  const dup = p.tiles.find((t, i, a) => a.findIndex((x) => x.n === t.n) !== i).n;
  g.guess(s, p.id, dup);
  assert.strictEqual(p.tiles.filter((t) => t.revealed).length, 1);
}

// 6b. 自分の画面では当てたタイルが先頭に来る（位置から大小を推測できない）
{
  const s = g.createGame(mk(2));
  const p = cur(s);
  const last = p.tiles[p.tiles.length - 1].n; // 最大の数字
  g.guess(s, p.id, last);
  const v = g.viewFor(s, p.id).players.find((x) => x.id === p.id);
  assert(v.tiles[0].revealed && v.tiles[0].n === last);
  assert(v.tiles.slice(1).every((t) => !t.revealed && t.n === null));
}

// 6c. 枚数上限：2〜3人で上限 k なら k 枚当てた時点で交代。4〜5人は設定に関係なく1枚
for (const k of [1, 2, 3]) {
  for (const n of [2, 3]) {
    const s = g.createGame(mk(n), Math.random, { hitLimit: k });
    const p = cur(s);
    for (let i = 0; i < k; i++) {
      assert.strictEqual(cur(s).id, p.id);
      g.guess(s, p.id, hasN(p));
    }
    assert.notStrictEqual(cur(s).id, p.id, `上限${k}枚で交代しない`);
    assert.strictEqual(s.hitsThisTurn, 0);
    assert.strictEqual(p.tiles.filter((t) => t.revealed).length, k);
  }
}
{
  const s = g.createGame(mk(4), Math.random, { hitLimit: 3 });
  const p = cur(s);
  g.guess(s, p.id, hasN(p));
  assert.notStrictEqual(cur(s).id, p.id);
  // 不正な設定値は無制限扱い／無制限なら viewFor は null
  const u = g.createGame(mk(2), Math.random, { hitLimit: 99 });
  assert.strictEqual(g.viewFor(u, u.players[0].id).maxHits, null);
}

// 7. 全員が常に正解し続ければ最後に勝者が出て、終了後は伏せも公開される
for (const k of [2, 3, 4, 5]) {
  const s = g.createGame(mk(k));
  let guard = 0;
  while (s.phase === 'playing' && guard++ < 200) g.guess(s, cur(s).id, hasN(cur(s)));
  assert.strictEqual(s.phase, 'ended');
  const w = s.players.find((p) => p.id === s.winner);
  assert(w.tiles.every((t) => t.revealed));
  const v = g.viewFor(s, s.players[0].id);
  assert(v.down.every((n) => n !== null));
  assert(!g.guess(s, cur(s).id, 1).ok);
}

console.log('game.js: すべてのテストに合格');
