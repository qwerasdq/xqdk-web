#!/usr/bin/env node
// 复制 onnxruntime-web 运行时资产到 public/ort/（不入 git，postinstall / build 前自动生成）
//
// 为什么需要：ORT 的 wasm 二进制不能由浏览器从 npm 包内加载，必须作为站点静态文件部署；
// 而 Cloudflare Worker 静态资源有 25 MiB/文件 的硬上限，超出会直接部署失败。
// 因此这里做体积断言——ort 升级后第一时间暴露。
// W6e 起只用非 jsep 构建（WASM EP，10.7 MiB；jsep 含 WebGPU EP，20.9 MiB，已随 WebGPU 移除）。
//
// glue（ort-wasm-simd-threaded.mjs）**改名成 .js 部署**：ORT 是把它当 ES module 动态 import 的，
// 而 EdgeOne Pages 不认识 .mjs 扩展名，按 application/octet-stream 返回，浏览器拒绝执行非 JS MIME 的
// 模块脚本，报 "Failed to fetch dynamically imported module"（Cloudflare 的 MIME 表认识 .mjs 才没事）。
// .js 在所有托管上都映射到 text/javascript。glue 内部不引用自身文件名（线程 worker 用
// new Worker(new URL(import.meta.url))），故改名安全。运行时用绝对 URL 显式指定两个文件，
// 见 src/vision/model.ts 的 setupOrt()。
//
// 用法：node scripts/vision-assets.mjs

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const DST_DIR = join(ROOT, 'public', 'ort')
// Cloudflare Worker 静态资源单文件上限（超过则 wrangler deploy 直接失败）
const FILE_LIMIT = 25 * 1024 * 1024
// 入口 onnxruntime-web/wasm 运行时只引用这两个文件（jsep 版内含 WebGPU EP，已不再使用）
// src = npm 包内文件名，dst = 站点上的文件名（glue 改名原因见文件头）
const ASSETS = [
  { src: 'ort-wasm-simd-threaded.wasm', dst: 'ort-wasm-simd-threaded.wasm' },
  { src: 'ort-wasm-simd-threaded.mjs', dst: 'ort-wasm-simd-threaded.js' },
]
const MiB = 1024 * 1024

const pkgPath = join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json')
if (!existsSync(pkgPath)) {
  console.error('[x] 未找到 onnxruntime-web —— 先执行 npm install')
  process.exit(1)
}
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version

mkdirSync(DST_DIR, { recursive: true })
let copied = 0
for (const { src: srcName, dst: dstName } of ASSETS) {
  const src = join(SRC_DIR, srcName)
  if (!existsSync(src)) {
    console.error(`[x] 缺少 ${srcName}（onnxruntime-web ${version} 布局与预期不符，检查版本）`)
    process.exit(1)
  }
  const size = statSync(src).size
  if (size > FILE_LIMIT) {
    console.error(
      `[x] ${srcName} 为 ${(size / MiB).toFixed(1)} MiB，超过 Cloudflare 单文件 25 MiB 上限\n` +
        `    需降级 onnxruntime-web 版本（1.22.x 非 jsep 为 10.7 MiB）或改用运行时外链下载`,
    )
    process.exit(1)
  }
  const dst = join(DST_DIR, dstName)
  if (!existsSync(dst) || statSync(dst).size !== size) {
    copyFileSync(src, dst)
    copied++
  }
  console.log(`    public/ort/${dstName}  ${(size / MiB).toFixed(2)} MiB`)
}

// 清掉本目录里过期的 ort 产物（例如 W6e 之前的 jsep 版、改名前的 .mjs glue），
// 否则会被一并部署上去白占体积，且旧 .mjs 会诱使排查往错方向走
const KEEP = new Set(ASSETS.map((a) => a.dst))
for (const name of readdirSync(DST_DIR)) {
  if (!name.startsWith('ort-wasm-') || KEEP.has(name)) continue
  rmSync(join(DST_DIR, name))
  console.log(`    清理过期 public/ort/${name}`)
}
writeFileSync(join(DST_DIR, 'VERSION'), `onnxruntime-web ${version}\n`)
console.log(`==> ORT 资产就绪（${ASSETS.length} 文件，新复制 ${copied}，版本 ${version}）`)
