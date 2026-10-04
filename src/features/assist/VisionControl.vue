<script setup lang="ts">
// JJ 自动识别控制：启动/停止 getDisplayMedia 屏幕捕获 + 当前后端（WebGPU/WASM）+ 稳定性
import { computed } from 'vue'
import type { Backend, VisionState } from '../../vision/useVision'

const props = defineProps<{
  state: VisionState
  backend: Backend | null
  lastError: string
  unstableStreak: number
  started: boolean
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'stop'): void
}>()

const isRunning = computed(() => props.state === 'capturing')
const isBusy = computed(() => props.state === 'loading' || props.state === 'capturing')
const statusText = computed(() => {
  switch (props.state) {
    case 'idle': return '未启动'
    case 'loading': return '加载模型…'
    case 'capturing': return `识别中（${props.backend ?? '…'}）`
    case 'error': return '识别出错'
  }
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
button.small.danger {
  border-color: #e74c3c;
  color: #c0392b;
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