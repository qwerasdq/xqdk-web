<script setup lang="ts">
// 视觉调试台（?visionLab=1）：静态截图 → 完整识别管线 → 日志/JSON
// 用于 W6b/W6c 验证：模型在浏览器 worker 内真实推理、检测/映射/tracker 行为。
// 数据源是 public/samples/ 下的静态图（不入 git，测试后删），代替 getDisplayMedia。

import { onBeforeUnmount, ref } from 'vue'

const MODEL_URL = new URL(import.meta.env.BASE_URL + 'models/xq-yolo-640.onnx', location.href).href
const ORT_DIR = new URL(import.meta.env.BASE_URL + 'ort/', location.href).href
const SAMPLES = ['2.jpg', '3.jpg', '4.jpg', '5.jpg']
const BASE = import.meta.env.BASE_URL

const log = ref<string[]>([])
const status = ref('idle')
const selectedSample = ref('2.jpg')
const running = ref(false)
const resultJson = ref('')

let worker: Worker | null = null
let frameId = 0
let keepAlive = false
let feeding = false

function push(line: string): void {
  log.value = [...log.value.slice(-80), `[${new Date().toLocaleTimeString()}] ${line}`]
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url)
  const blob = await resp.blob()
  return await createImageBitmap(blob)
}

async function feedNext(): Promise<void> {
  if (!worker || !keepAlive || feeding) return
  feeding = true
  try {
    const bitmap = await loadImage(`${BASE}samples/${selectedSample.value}`)
    const id = ++frameId
    worker.postMessage({ type: 'frame', id, bitmap, frameW: bitmap.width, frameH: bitmap.height }, [bitmap])
  } catch (e) {
    push(`读取样本失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    feeding = false
    if (keepAlive) setTimeout(() => void feedNext(), 500)
  }
}

function spawn(): void {
  const current = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker = current

  current.onmessage = (e: MessageEvent) => {
    if (current !== worker) return
    const m = e.data
    if (m.type === 'ready') {
      status.value = `ready (wasm)`
      push(`模型就绪：wasm，加载 ${m.loadMs}ms`)
      void feedNext()
    } else if (m.type === 'frame-result') {
      if (m.error) {
        push(`帧 ${m.id} 错误：${m.error}`)
      } else {
        const short = m.event === 'UNSTABLE' ? '' : ` → ${m.event}（棋子 ${m.mapped?.pieceCount ?? '?'}）`
        const t = m.timings as { pre: number; infer: number; post: number }
        push(`帧 ${m.id}：检测 ${m.detections}${short} [预处理 ${t.pre.toFixed(1)} / 推理 ${t.infer.toFixed(1)} / 后处理 ${t.post.toFixed(1)} ms]`)
        if (m.mapped) {
          resultJson.value = JSON.stringify(
            { event: m.event, pieces: m.mapped.pieceCount, avg: +m.mapped.avgScore.toFixed(3), dropped: m.mapped.dropped, orientation: m.mapped.orientation },
            null,
            2,
          )
        }
      }
    } else if (m.type === 'init-error') {
      status.value = `error: ${m.message}`
      push(`初始化失败：${m.stage} ${m.message}`)
      stop()
    } else if (m.type === 'log') {
      push(m.text)
    }
  }
  current.onerror = (e) => {
    if (current !== worker) return
    status.value = `worker error: ${e.message}`
    push(`worker 异常：${e.message}`)
    stop()
  }
  current.postMessage({ type: 'init', modelUrl: MODEL_URL, ortDir: ORT_DIR })
}

function start(): void {
  if (running.value) return
  running.value = true
  keepAlive = true
  status.value = 'loading'
  push('初始化识别 worker…')
  spawn()
}

function stop(): void {
  keepAlive = false
  if (worker) {
    worker.postMessage({ type: 'dispose' })
    worker.terminate()
    worker = null
  }
  running.value = false
  status.value = 'idle'
}

onBeforeUnmount(() => stop())
</script>

<template>
  <div class="lab">
    <h2>视觉识别调试台（?visionLab=1）</h2>
    <div class="row">
      <select v-model="selectedSample" :disabled="running">
        <option v-for="s in SAMPLES" :key="s" :value="s">{{ s }}</option>
      </select>
      <button v-if="!running" @click="start">开始推理</button>
      <button v-else @click="stop">停止</button>
      <span class="status" :class="{ run: running }">{{ status }}</span>
    </div>
    <pre class="json">{{ resultJson }}</pre>
    <pre class="log">{{ log.join('\n') }}</pre>
  </div>
</template>

<style scoped>
.lab {
  font-family: ui-monospace, Consolas, monospace;
  padding: 16px;
  max-width: 1100px;
  margin: 0 auto;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}
.status {
  color: #888;
}
.status.run {
  color: #2e7d32;
}
.json {
  font-size: 12px;
  color: #0a0;
  background: #111;
  padding: 8px;
  min-height: 80px;
}
.log {
  max-height: 70vh;
  overflow-y: auto;
  background: #111;
  color: #9f9;
  padding: 10px;
  font-size: 11px;
  white-space: pre-wrap;
}
</style>
