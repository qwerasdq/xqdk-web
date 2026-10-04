#!/usr/bin/env node
// 复制 onnxruntime-web 运行时资产到 public/ort/（不入 git，postinstall / build 前自动生成）
//
// 为什么需要：ORT 的 wasm 二进制不能由浏览器从 npm 包内加载，必须作为站点静态文件部署；
// 而 Cloudflare Worker 静态资源有 25 MiB/文件 的硬上限，超出会直接部署失败。
// 因此这里做体积断言——ort 将来升级到 1.30+ 时第一时间暴露（jsep wasm 会涨到 27 MiB）。
//
// 用法：node scripts/vision-assets.mjs

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const DST_DIR = join(ROOT, 'public', 'ort')
// Cloudflare Worker 静态资源单文件上限（超过则 wrangler deploy 直接失败）
const FILE_LIMIT = 25 * 1024 * 1024
// ort.webgpu / ort.bundle 入口运行时只引用 jsep 这两个文件（wasm 内含 wasm EP + WebGPU EP）
const ASSETS = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']
const MiB = 1024 * 1024

const pkgPath = join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json')
if (!existsSync(pkgPath)) {
  console.error('[x] 未找到 onnxruntime-web —— 先执行 npm install')
  process.exit(1)
}
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version

mkdirSync(DST_DIR, { recursive: true })
let copied = 0
for (const name of ASSETS) {
  const src = join(SRC_DIR, name)
  if (!existsSync(src)) {
    console.error(`[x] 缺少 ${name}（onnxruntime-web ${version} 布局与预期不符，检查版本）`)
    process.exit(1)
  }
  const size = statSync(src).size
  if (size > FILE_LIMIT) {
    console.error(
      `[x] ${name} 为 ${(size / MiB).toFixed(1)} MiB，超过 Cloudflare 单文件 25 MiB 上限\n` +
        `    需降级 onnxruntime-web 版本（1.22.x 为 20.9 MiB）或改用运行时外链下载`,
    )
    process.exit(1)
  }
  const dst = join(DST_DIR, name)
  if (!existsSync(dst) || statSync(dst).size !== size) {
    copyFileSync(src, dst)
    copied++
  }
  console.log(`    public/ort/${name}  ${(size / MiB).toFixed(2)} MiB`)
}
writeFileSync(join(DST_DIR, 'VERSION'), `onnxruntime-web ${version}\n`)
console.log(`==> ORT 资产就绪（${ASSETS.length} 文件，新复制 ${copied}，版本 ${version}）`)