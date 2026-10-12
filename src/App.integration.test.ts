// @vitest-environment happy-dom
// JJ 支招 UI 状态集成测试：自动识别时隐藏手动同步文案、预案补全状态
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import App from './App.vue'

// mock 引擎/识别/预案：集成测试只验证 UI 状态分派，不加载真实 WASM/Worker
vi.mock('./engine/useEngine', () => ({
  useEngine: () => ({
    status: ref('ready'),
    engineName: ref('Pikafish'),
    error: ref(''),
  }),
  initEngine: vi.fn(),
  engineSearch: vi.fn(),
  engineAnalyze: vi.fn(),
  engineNewGame: vi.fn(),
  setEngineOption: vi.fn(),
  cancelEngineSearch: vi.fn(),
  EngineSearchCancelledError: class extends Error {},
  onEngineInfo: () => () => {},
  clearAnalysisCache: vi.fn(),
}))

vi.mock('./vision/useVision', () => ({
  useVision: () => ({
    state: {
      state: 'capturing',
      lastError: '',
      unstableStreak: 0,
      started: true,
      sourceInfo: null,
      lastFrameDiag: null,
    },
    start: vi.fn(),
    stop: vi.fn(),
    resetTracker: vi.fn(),
    ackDecision: vi.fn(),
    attachPreview: vi.fn(),
  }),
}))

vi.mock('./features/assist/plans', () => ({
  buildPlans: vi.fn(async (_req, onPlan) => {
    onPlan({
      oppUcci: 'h2e2',
      oppChs: '炮二平五 (h2e2)',
      myUcci: 'h0g2',
      myChs: '马二进三 (h0g2)',
    })
  }),
}))

// 避免真实引擎初始化/PWA
vi.mock('vite-plugin-pwa', () => ({ registerSW: vi.fn() }))

describe('App JJ 支招集成', () => {
  it('自动识别已启动时，JJ 面板不显示“点右侧棋盘同步”手动文案', async () => {
    const wrapper = mount(App)
    // 切到 JJ 模式
    const buttons = wrapper.findAll('button')
    const jjBtn = buttons.find((b) => b.text().includes('JJ 支招'))
    expect(jjBtn).toBeTruthy()
    await jjBtn!.trigger('click')
    await wrapper.vm.$nextTick()

    const text = wrapper.text()
    expect(text).not.toContain('点右侧棋盘同步')
  })
})
