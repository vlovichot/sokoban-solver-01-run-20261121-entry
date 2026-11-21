// Sokoban solver: push-optimal, room by room.
//
// The generator lays a hallway across the board with rooms off it; a box
// pushed into the hallway can never return, so each room is independent
// and the level optimum is the sum of the rooms' optima. Each room is
// solved with A* over pushes (cost 1 per push, player walks free between
// pushes), with:
//   - a state of the boxes' squares plus the player's reachable region
//     (named by its lowest square: two player squares in one region are
//     the same state),
//   - an admissible, consistent heuristic: the minimum assignment of
//     boxes to goals under shortest-push distances (each push moves one
//     box one square),
//   - deadlock pruning: dead squares (no push, ignoring the other boxes,
//     brings a box to any goal) and frozen 2x2 blocks of walls/boxes with
//     a box off its goal.
// Ties break by deeper first, then insertion order, so the search is
// deterministic; the budget is counted in expanded states, never the
// clock, so two runs write the same bytes. No dependencies, no network.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** Most states one room search expands before it gives up. */
const MAX_STATES = 250_000;
/** Most states the whole-level fallback expands. */
const MAX_STATES_WHOLE = 250_000;

const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can be pushed onto some goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Shortest-push distance from every square to each goal: dist[g][c] is the
 * fewest pushes moving a box from c onto goal g, ignoring other boxes
 * (a push from c to c+d needs the square behind, c-d, to be open floor).
 * Infinity when no such push path exists.
 */
function pushDistances(level: Level): number[][] {
  const { w, wall, goals } = level;
  const size = wall.length;
  const INF = 1e9;
  const dist: number[][] = [];
  for (const g of goals) {
    const d = new Array<number>(size).fill(INF);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const dd = dy * w + dx;
        const q = p - dd; // a box on q pushes to p
        if (wall[q] || wall[q - dd] || d[q] !== INF) continue;
        d[q] = d[p]! + 1;
        queue.push(q);
      }
    }
    dist.push(d);
  }
  return dist;
}

/** Minimum assignment of boxes to goals under dist; Infinity if impossible. */
function assignmentHeuristic(boxes: number[], dist: number[][], nGoals: number): number {
  const n = boxes.length;
  const INF = 1e9;
  if (n === 0) return 0;
  if (n > nGoals) return INF;
  // DP over goal subsets: dp[mask] = min cost assigning the first popcount(mask) boxes.
  const size = 1 << nGoals;
  const dp = new Array<number>(size).fill(INF);
  dp[0] = 0;
  const pop = new Array<number>(size).fill(0);
  for (let m = 1; m < size; m++) pop[m] = pop[m >> 1]! + (m & 1);
  for (let mask = 0; mask < size; mask++) {
    const k = pop[mask]!;
    if (k >= n || dp[mask] === INF) continue;
    const b = boxes[k]!;
    for (let g = 0; g < nGoals; g++) {
      if (mask & (1 << g)) continue;
      const c = dist[g]![b]!;
      if (c >= INF) continue;
      const nm = mask | (1 << g);
      const v = dp[mask]! + c;
      if (v < dp[nm]!) dp[nm] = v;
    }
  }
  let best = INF;
  for (let mask = 0; mask < size; mask++) {
    if (pop[mask] === n && dp[mask]! < best) best = dp[mask]!;
  }
  return best;
}

/** Lowest square of the player's reachable region from `from`, marking `seen` with `stamp`. */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal solution of `level` by A* over pushes, or null when the
 * search gives up (or the level has no solution). The heuristic is
 * admissible and consistent, so the first goal state popped is optimal.
 */
function solvePushOptimal(level: Level, maxStates = MAX_STATES): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = pushDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  const h0 = assignmentHeuristic(level.boxes, dist, goals.length);
  if (h0 >= 1e9) return null;

  const boxesArr: number[][] = [level.boxes];
  const playerArr: number[] = [level.player];
  const parent: number[] = [-1];
  const g: number[] = [0];
  const f: number[] = [h0];
  const seq: number[] = [0];
  const closed: number[] = [0];
  let seqNext = 1;
  const keyOf = (boxes: number[], low: number): string => low + ':' + boxes.join(',');
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reachLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap of node indices on (f, -g, seq): smallest f first, deeper first on ties.
  const heap: number[] = [];
  const heapLess = (a: number, b: number): boolean => {
    if (f[a] !== f[b]) return f[a]! < f[b]!;
    if (g[a] !== g[b]) return g[a]! > g[b]!;
    return seq[a]! < seq[b]!;
  };
  const heapPush = (x: number): void => {
    let i = heap.length;
    heap.push(x);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  heapPush(0);
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const s = heapPop();
    if (closed[s]!) continue;
    closed[s] = 1;
    if (solved(boxesArr[s]!)) {
      found = s;
      break;
    }
    if (expanded >= maxStates) return null;
    expanded++;
    const boxes = boxesArr[s]!;
    const p0 = playerArr[s]!;
    for (const b of boxes) occupied[b] = 1;
    reachLow(level, occupied, p0, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let low = -1;
        if (!frozen) {
          low = reachLow(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(nextBoxes(boxes, bi, t), low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const ng = g[s]! + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        const next = nextBoxes(boxes, bi, t);
        const h = assignmentHeuristic(next, dist, goals.length);
        if (h >= 1e9) continue;
        best.set(key, ng);
        const idx = boxesArr.length;
        boxesArr.push(next);
        playerArr.push(b);
        parent.push(s);
        g.push(ng);
        f.push(ng + h);
        seq.push(seqNext++);
        closed.push(0);
        heapPush(idx);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // Reconstruct: replay the state path, walking to each push's square.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = boxesArr[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

function nextBoxes(boxes: number[], bi: number, t: number): number[] {
  const next = boxes.slice();
  next[bi] = t;
  next.sort((a, b) => a - b);
  return next;
}

/** The level's rooms: cut the hallway row's dead squares out of the floor. */
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const gg of goals) if (part[gg]! >= 0) rooms[part[gg]!]!.goals.push(gg);
  if (goals.some((gg) => part[gg]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Solve room by room; fall back to a whole-level search when the level is no set of rooms. */
function solve(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_STATES_WHOLE);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_STATES);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    const solved = solve(level);
    if (solved !== null) moves = solved.moves;
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
