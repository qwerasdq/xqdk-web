<script setup lang="ts">
// JJ 支招面板（手动摆棋同步）：我方执红/黑 + 回合提示 + 我方候选 + 对方应对预案 + 合规提示
// 设计对齐 Android 版 assist-helper：对方回合引擎算力为我方所用（"若对方走X，我方应Y"）
// W6b：自动识别屏幕棋盘（getDisplayMedia，只读捕获）实时同步
import { computed } from 'vue'
import AnalysisPanel from '../../components/analysis/AnalysisPanel.vue'
import type { AnalysisLine } from '../../engine/useEngine'
import type { Backend, VisionSourceInfo, VisionState } from '../../vision/useVision'
import type { AssistPlan } from './plans'
import VisionControl, { type FrameDiag, type PendingSyncSnapshot } from './VisionControl.vue'

const props = defineProps<{
  fen: string
  mySide: 'red' | 'black'
  /** 当前行棋方是否红（对局状态） */
  redGo: boolean
  /** 我方回合的候选（引擎 MultiPV） */
  lines: AnalysisLine[]
  /** 对方回合的应对预案 */
  plans: AssistPlan[]
  plansLoading: boolean
  analyzing: boolean
  selectedUcci: string | null
  selectedPlan: number
  visionState: VisionState
  visionBackend: Backend | null
  visionError: string
  visionUnstableStreak: number
  visionStarted: boolean
  visionSourceInfo: VisionSourceInfo | null
  visionPendingSync: PendingSyncSnapshot | null
  visionFrameDiag: FrameDiag | null
  visionBackendNotice: string
}>()

const emit = defineEmits<{
  (e: 'update:mySide', side: 'red' | 'black'): void
  (e: 'select-candidate', ucci: string): void
  (e: 'select-plan', index: number): void
  (e: 'vision-start'): void
  (e: 'vision-stop'): void
  (e: 'vision-confirm-pending'): void
  (e: 'vision-discard-pending'): void
  (e: 'vision-preview-ready', canvas: HTMLCanvasElement | null): void
  (e: 'vision-reconnect'): void
}>()

const myTurn = computed(() => (props.redGo ? 'red' : 'black') === props.mySide)
</script>

<template>
  <div class="assist">
    <!-- 合规提示（沿用 Android 版口径，针对手动摆棋场景调整） -->
    <div class="compliance">
      仅限休闲对局的学习辅助：本工具<strong>无自动走子、无任何注入</strong>，只显示建议由你手动落子。
      严禁在排位赛、比赛或任何禁止辅助的场合使用，违规后果自负。
    </div>

    <VisionControl
      :state="visionState"
      :backend="visionBackend"
      :last-error="visionError"
      :unstable-streak="visionUnstableStreak"
      :started="visionStarted"
      :source-info="visionSourceInfo"
      :pending-sync="visionPendingSync"
      :last-frame-diag="visionFrameDiag"
      :backend-notice="visionBackendNotice"
      @start="emit('vision-start')"
      @stop="emit('vision-stop')"
      @confirm-pending="emit('vision-confirm-pending')"
      @discard-pending="emit('vision-discard-pending')"
      @preview-ready="(c) => emit('vision-preview-ready', c)"
      @reconnect="emit('vision-reconnect')"
    />

    <div class="row">
      <span class="label">我方执</span>
      <div class="side-toggle">
        <button :class="{ active: mySide === 'red' }" @click="emit('update:mySide', 'red')">红</button>
        <button :class="{ active: mySide === 'black' }" @click="emit('update:mySide', 'black')">黑</button>
      </div>
      <span class="turn" :class="{ mine: myTurn }">
        {{ myTurn ? '轮到你走' : '轮到对方走' }}
      </span>
    </div>

    <div class="hint">
      {{ myTurn
        ? '在 JJ 落子后，点右侧棋盘同步同一着法；下面是引擎建议'
        : '对方走完后，点右侧棋盘同步对方的着法；下面是应对预案' }}
    </div>

    <!-- 我方回合：候选着法（复用分析面板：评分/胜率/候选/PV） -->
    <AnalysisPanel
      v-if="myTurn"
      :fen="fen"
      :lines="lines"
      :selected-ucci="selectedUcci"
      :analyzing="analyzing"
      @select="(u) => emit('select-candidate', u)"
    />

    <!-- 对方回合：应对预案列表 -->
    <div v-else class="plans">
      <div class="plans-title">
        对方可能走法与我方应对
        <span v-if="plansLoading" class="loading">计算中…</span>
      </div>
      <button
        v-for="(p, i) in plans"
        :key="i"
        class="plan"
        :class="{ active: selectedPlan === i }"
        @click="emit('select-plan', i)"
      >
        <span class="plan-opp">若对方走 {{ p.oppChs }}</span>
        <span class="plan-arrow">→</span>
        <span class="plan-my">我方应 {{ p.myChs }}</span>
      </button>
      <div v-if="plans.length === 0 && !plansLoading" class="empty">暂无预案</div>
    </div>
  </div>
</template>

<style scoped>
.assist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}
.compliance {
  font-size: 12px;
  line-height: 1.5;
  color: #7a5b2b;
  background: #fdf6e3;
  border: 1px solid #e8d5a8;
  border-radius: 6px;
  padding: 6px 8px;
}
.compliance strong {
  color: #b35900;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  color: #666;
}
.side-toggle {
  display: flex;
}
.side-toggle button {
  padding: 4px 14px;
  border: 1px solid #bbb;
  background: #fff;
  cursor: pointer;
}
.side-toggle button:first-child {
  border-radius: 6px 0 0 6px;
}
.side-toggle button:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.side-toggle button.active {
  background: #5a3a1e;
  color: #fff;
  border-color: #5a3a1e;
}
.turn {
  margin-left: auto;
  font-weight: bold;
  color: #888;
}
.turn.mine {
  color: #2e7d32;
}
.hint {
  font-size: 12px;
  color: #888;
}
.plans {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.plans-title {
  font-size: 13px;
  color: #666;
}
.loading {
  color: #e67e22;
  margin-left: 6px;
}
.plan {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.plan:hover {
  background: #fdf3e3;
}
.plan.active {
  border-color: #e67e22;
  background: #fdf0dd;
  box-shadow: 0 0 0 1px #e67e22 inset;
}
.plan-opp {
  color: #555;
}
.plan-arrow {
  color: #999;
}
.plan-my {
  font-weight: bold;
  color: #2e6bdb;
}
.empty {
  color: #999;
  font-size: 13px;
  padding: 6px 0;
}
</style>
