// useVision / capture 的轻量逻辑测试（不模拟 getDisplayMedia）
import { describe, expect, it } from 'vitest'
import { useVision } from './useVision'

describe('useVision', () => {
  it('初始为 idle 且无后端', () => {
    const vision = useVision('/models/x', '/ort/')
    expect(vision.state.state).toBe('idle')
    expect(vision.state.backend).toBeNull()
    expect(vision.state.started).toBe(false)
  })
})
