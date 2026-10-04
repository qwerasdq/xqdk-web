import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '象棋迪克 Web',
        short_name: '象棋迪克',
        description: '中国象棋 AI 辅助对弈：人机对弈 / 支招分析 / 复盘拆棋',
        lang: 'zh-CN',
        display: 'standalone',
        theme_color: '#f0d9b5',
        background_color: '#f0d9b5',
      },
      workbox: {
        // 应用壳 precache（带 hash 的 js/css/html）
        globPatterns: ['**/*.{js,css,html}'],
        // 引擎文件（pikafish.js/wasm/data）运行时缓存：
        // 不入 precache（避免首启双倍下载），CacheFirst 永久缓存，版本化 URL 更新
        runtimeCaching: [
          {
            urlPattern: /\/engine\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'engine-assets',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            // 识别模型 + ORT wasm（均 >5MiB，不入 precache，部署后首次加载会缓存）
            urlPattern: /\/(models|ort)\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vision-assets',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
  base: './',
  resolve: {
    // onnxruntime-web 的 extern-wasm 入口：不内联 jsep.wasm，
    // 运行时通过 env.wasm.wasmPaths 从 public/ort/ 加载，避免 Vite 把它复制成另一份 hash asset
    conditions: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
  },
  // Pikafish WASM 为 pthread 构建，需要 SharedArrayBuffer（跨源隔离）
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
