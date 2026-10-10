// 评分文案（红方视角）：+0.35 / -0.62 / 红方 5 步杀 / 红方 3 步被杀
// 单独成模块便于单测：mate 符号是踩过坑的地方（见 uci.ts EngineScore.value 注释）。

import type { EngineScore } from './uci'

/**
 * 把**已换算成红方视角**的评分转成展示文案。
 * 注意入参必须是 toRedScore 的结果：mate 为正 = 红方将杀对方。
 */
export function scoreText(s: EngineScore): string {
  if (s.kind === 'mate') {
    return s.value > 0 ? `红方 ${s.value} 步杀` : `红方 ${-s.value} 步被杀`
  }
  const v = s.value / 100
  return (v >= 0 ? '+' : '') + v.toFixed(2)
}
