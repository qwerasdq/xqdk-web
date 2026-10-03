// Zobrist 局面哈希。
// Android 版（Zobrist.java）使用从"华弈2022开局库"提取的固定 64 位常量表，
// 与开局库 vkey 查询耦合。Web 端 MVP 不开局库，只需要"会话内一致"的局面键
// 用于重复局面检测，因此改用种子化 PRNG 生成表（无版权依赖）。
// 若未来接入开局库，需替换为与 Android 版一致的常量表。
//
// 键值用 BigInt 表示 64 位无符号数，避免 JS number 精度丢失。

const WIDTH = 9
const HEIGHT = 10
const PIECE_COUNT = 15 // 1..14 棋子 + side 键

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function genTable(): bigint[][] {
  const rand = mulberry32(0x58444b) // "XQDK"
  const table: bigint[][] = []
  for (let p = 0; p < PIECE_COUNT; p++) {
    const row: bigint[] = []
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const hi = BigInt(Math.floor(rand() * 0x100000000))
      const lo = BigInt(Math.floor(rand() * 0x100000000))
      row.push((hi << 32n) | lo)
    }
    table.push(row)
  }
  return table
}

const table = genTable()

export function getZobristFromBoard(piece: number[][], redGo: boolean): bigint {
  let key = 0n
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = piece[y][x]
      if (p !== 0) {
        key ^= table[p][y * WIDTH + x]
      }
    }
  }
  if (redGo) {
    key ^= table[0][0] // side 键复用第 0 行
  }
  return key
}
