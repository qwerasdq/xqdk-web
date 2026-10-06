<script setup lang="ts">
// JJ 自动识别控制：启动/停止 getDisplayMedia 屏幕捕获 + 当前后端（WebGPU/WASM）+ 稳定性
// W6c：捕获预览缩略图（Chrome 不暴露窗口标题，靠画面确认来源）+ 逐帧诊断
// W6d：后端降级提示与「重连 WebGPU」（设备丢失后自动降级 WASM，手动可尝试拿回 GPU）
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Backend, VisionSourceInfo, VisionState } from '../../vision/useVision'

export interface PendingSyncSnapshot {
  event: string
  reason: string
}

export interface FrameDiag {
  detections: number
  pieceCount: number | null
  issues: string[]
  candidateFrames: number
  frameW: number
  frameH: number
}

const props = defineProps<{
  state: VisionState
  backend: Backend | null
  backendNotice: string
  lastError: string
  unstableStreak: number
  started: boolean
  sourceInfo: VisionSourceInfo | null
  pendingSync: PendingSyncSnapshot | null
  lastFrameDiag: FrameDiag | null
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'stop'): void
  (e: 'confirm-pending'): void
  (e: 'discard-pending'): void
  (e: 'preview-ready', canvas: HTMLCanvasElement | null): void
  (e: 'reconnect'): void
}>()

const isRunning = computed(() => props.state === 'capturing' || props.state === 'awaiting-confirm')
const isBusy = computed(() => props.state === 'loading' || props.state === 'capturing')
/** WASM 后端 + 有降级提示 = 可能可以尝试恢复 WebGPU */
const canReconnect = computed(() => props.backend === 'wasm' && !!props.backendNotice && props.state !== 'idle' && props.state !== 'loading')
const statusText = computed(() => {
  switch (props.state) {
    case 'idle': return '未启动'
    case 'loading': return '加载模型…'
    case 'capturing': return `识别中（${props.backend ?? '…'}）`
    case 'awaiting-confirm': return '待确认同步'
    case 'error': return '识别出错'
  }
})
const sourceLabel = computed(() => {
  const s = props.sourceInfo
  if (!s?.label) return ''
  const kind = s.displaySurface === 'monitor' ? '显示器' : s.displaySurface === 'window' ? '窗口' : s.displaySurface === 'browser' ? '标签页' : '来源'
  return `${s.label}（${kind}）`
})

// 预览画布：挂载即上报给上层（capture 会向其中绘制抽帧）
const preview = ref<HTMLCanvasElement | null>(null)
watch(preview, (c) => emit('preview-ready', c))

onBeforeUnmount(() => {
  emit('preview-ready', null)
})

const diagText = computed(() => {
  const d = props.lastFrameDiag
  if (!d || props.state === 'idle' || props.state === 'loading') return ''
  const parts: string[] = []
  parts.push(d.pieceCount !== null ? `识别到 ${d.pieceCount} 子` : `检测 ${d.detections} 框`)
  if (d.issues.length) parts.push(`校验失败：${d.issues.join('、')}`)
  else if (d.pieceCount !== null) parts.push(`稳定 ${Math.min(d.candidateFrames, 3)}/3 帧`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="vision">
    <div class="vision-head">
      <span class="title">自动识别 JJ 棋盘</span>
      <span class="status" :class="{ running: isRunning, error: state === 'error' }">
        {{ statusText }}
        <em v-if="unstableStreak >= 15"> · 不稳定</em>
      </span>
    </div>
    <div class="vision-actions">
      <button v-if="!isRunning" class="small" :disabled="isBusy" @click="emit('start')">
        {{ state === 'error' ? '重试' : '开始捕获' }}
      </button>
      <button v-else class="small danger" @click="emit('stop')">停止</button>
    </div>
    <p v-if="sourceInfo && state !== 'idle'" class="source">{{ sourceLabel }}</p>
    <canvas v-show="isRunning" ref="preview" class="preview" />
    <p v-if="diagText" class="diag">{{ diagText }}</p>
    <div v-if="backendNotice" class="backend-notice">
      <span class="backend-notice-text">{{ backendNotice }}</span>
      <button v-if="canReconnect" class="small" @click="emit('reconnect')">重连 WebGPU</button>
    </div>
    <div v-if="pendingSync" class="pending">
      <span class="pending-text">识别到{{ pendingSync.event === 'NEW_GAME' ? '新对局' : '新局面' }}，{{ pendingSync.reason }}</span>
      <button class="small primary" @click="emit('confirm-pending')">确认同步</button>
      <button class="small danger" @click="emit('discard-pending')">丢弃</button>
    </div>
    <p v-if="state === 'error'" class="error">{{ lastError }}</p>
    <p class="note">
      只读捕获 JJ 窗口，实时同步局面；浏览器首次会请求屏幕共享授权。
      捕获流仅在本页内存中处理，不上传。
    </p>
  </div>
</template>

<style scoped>
.vision {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #faf7f0;
}
.vision-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title {
  font-weight: bold;
  font-size: 14px;
}
.status {
  margin-left: auto;
  font-size: 12px;
  color: #888;
}
.status.running {
  color: #2e7d32;
}
.status.error {
  color: #c0392b;
}
.status em {
  font-style: normal;
  color: #e67e22;
}
.vision-actions {
  display: flex;
  gap: 6px;
}
button.small {
  padding: 4px 12px;
  font-size: 13px;
}
button.small.primary {
  border-color: #2e6bdb;
  color: #2e6bdb;
}
button.small.danger {
  border-color: #e74c3c;
  color: #c0392b;
}
.source {
  margin: 0;
  font-size: 12px;
  color: #666;
}
.preview {
  width: 100%;
  max-height: 160px;
  object-fit: contain;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #000;
}
.diag {
  margin: 0;
  font-size: 12px;
  color: #8a6d3b;
}
.backend-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid #e0c080;
  border-radius: 6px;
  background: #fdf4e3;
  font-size: 12px;
}
.backend-notice-text {
  color: #8a6d3b;
  flex: 1;
  min-width: 150px;
}
.pending {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid #e8b84b;
  border-radius: 6px;
  background: #fff7e0;
  font-size: 12px;
}
.pending-text {
  color: #8a6d3b;
  flex: 1;
  min-width: 150px;
}
.error {
  color: #c0392b;
  font-size: 12px;
  margin: 0;
}
.note {
  color: #888;
  font-size: 12px;
  margin: 0;
}
</style>