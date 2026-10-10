<script setup lang="ts">
// 分析面板：评分/胜率 + 候选着法列表 + PV 变例（中文着法）
import { computed } from 'vue'
import type { AnalysisLine } from '../../engine/useEngine'
import { scoreText } from '../../engine/scoreText'
import { describeMove, pvToChinese } from '../../xiangqi/pv'

const props = defineProps<{
  fen: string
  lines: AnalysisLine[]
  /** 当前选中候选的 UCCI 首着 */
  selectedUcci: string | null
  analyzing: boolean
}>()

const emit = defineEmits<{ (e: 'select', ucci: string): void }>()

const mainLine = computed(() => (props.lines.length > 0 ? props.lines[0]! : null))

function winText(l: AnalysisLine): string {
  return (l.winRateRed * 100).toFixed(1) + '%'
}

// 选中候选的 PV 中文着法（前 4 步，照抄 Android 版"预测后续 4 步"）
const pvChs = computed(() => {
  const line = props.lines.find((l) => l.pv[0] === props.selectedUcci) ?? mainLine.value
  if (!line || line.pv.length === 0) return []
  return pvToChinese(props.fen, line.pv).slice(0, 4)
})
</script>

<template>
  <div class="analysis-panel">
    <div class="eval-row" v-if="mainLine">
      <span class="score" :class="{ red: mainLine.scoreRed.value > 0 }">{{ scoreText(mainLine.scoreRed) }}</span>
      <span class="winrate">红方胜率 {{ winText(mainLine) }}</span>
      <span class="depth">深度 {{ mainLine.depth }}</span>
    </div>
    <div class="eval-row" v-else>
      <span class="hint">{{ analyzing ? '分析中…' : '—' }}</span>
    </div>

    <div class="candidates">
      <button
        v-for="l in lines"
        :key="l.multipv"
        class="cand"
        :class="{ active: l.pv[0] === selectedUcci }"
        @click="emit('select', l.pv[0] ?? '')"
      >
        <span class="cand-num">{{ l.multipv }}</span>
        <span class="cand-move">{{ l.pv.length > 0 ? describeMove(fen, l.pv[0]!) : '—' }}</span>
        <span class="cand-score" :class="{ red: l.scoreRed.value > 0 }">{{ scoreText(l.scoreRed) }}</span>
        <span class="cand-win">{{ winText(l) }}</span>
      </button>
    </div>

    <div class="pv" v-if="pvChs.length > 0">
      <span class="pv-label">变例</span>
      <span v-for="(m, i) in pvChs" :key="i" class="pv-step">{{ i + 1 }}.{{ m }}</span>
    </div>
  </div>
</template>

<style scoped>
.analysis-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}
.eval-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: #f7f2e7;
  border: 1px solid #ddd;
  border-radius: 6px;
}
.score {
  font-weight: bold;
  font-size: 16px;
  color: #2c3e50;
}
.score.red {
  color: #c0392b;
}
.winrate {
  color: #666;
}
.depth {
  margin-left: auto;
  color: #999;
  font-size: 12px;
}
.hint {
  color: #999;
}
.candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font-size: 14px;
}
.cand:hover {
  background: #fdf3e3;
}
.cand.active {
  border-color: #e67e22;
  background: #fdf0dd;
  box-shadow: 0 0 0 1px #e67e22 inset;
}
.cand-num {
  color: #999;
  width: 14px;
  text-align: center;
}
.cand-move {
  flex: 1;
  font-weight: bold;
}
.cand-score {
  color: #2c3e50;
  font-variant-numeric: tabular-nums;
}
.cand-score.red {
  color: #c0392b;
}
.cand-win {
  color: #888;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.pv {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  background: #fbfaf7;
  border: 1px dashed #ccc;
  border-radius: 6px;
  font-size: 13px;
}
.pv-label {
  color: #999;
}
.pv-step {
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 4px;
  padding: 2px 6px;
}
</style>
