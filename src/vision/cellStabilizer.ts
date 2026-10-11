// 逐格时间稳定器：同一格要连续 needFrames 帧出现同一个新值才改变，单帧抖动被吸收。
//
// 动机（JJ 实机与 Android 端共同的「识别不稳定 / 识别错」根因）：
// BoardTracker 用「整盘逐格完全一致」做确认，粒度是整盘。于是——
//   1) 任一格瞬时抖动（棋子被走子高亮环/动画遮挡、检测框在相邻格之间跳变、UI 元素偶发误检）
//      都会让整盘与当前确认局面不等，候选计数被重置 → 一直 UNSTABLE（"识别不稳定"）；
//   2) 反过来，同一个误检若连续 3 帧出现，又会被当成新局面确认下来（"识别错"）。
// 逐格去抖把问题收敛到"单格"维度：瞬时抖动被吸收，持续多帧的变化才生效；而持续多帧的
// 误检仍可被下游（规则层合法着法校验 / 人工确认）拦截。
//
// 只做时间维度去抖，不猜内容——不引入任何棋子/棋规知识，与 Android 侧逻辑保持同一语义。

/** 默认去抖帧数：连续 2 帧一致即采纳（~800ms/帧下约 1.6s 确认一格变化） */
export const DEFAULT_NEED_FRAMES = 2

export class CellStabilizer {
  private stable: Uint8Array | null = null
  private readonly pending: Uint8Array
  private readonly hits: Uint8Array

  constructor(
    private readonly cells: number,
    private readonly needFrames: number = DEFAULT_NEED_FRAMES,
  ) {
    this.pending = new Uint8Array(cells)
    this.hits = new Uint8Array(cells)
  }

  /** 丢弃历史（新对局/手动改盘后调用），下一次 update 重新冷启动 */
  reset(): void {
    this.stable = null
    this.pending.fill(0)
    this.hits.fill(0)
  }

  /**
   * 输入一帧原始局面，返回去抖后的稳定局面。
   * 首帧直接采纳（冷启动不引入延迟）；返回的是**新数组**，调用方可安全持有/比较，
   * 不会被后续帧改写。
   */
  update(raw: Uint8Array): Uint8Array {
    if (raw.length !== this.cells) throw new Error(`局面长度 ${raw.length} 与稳定器容量 ${this.cells} 不符`)

    if (this.stable === null) {
      this.stable = raw.slice()
      this.pending.set(raw)
      this.hits.fill(0)
      return this.stable.slice()
    }

    const s = this.stable
    for (let i = 0; i < this.cells; i++) {
      const v = raw[i]!
      if (v === s[i]) {
        // 与稳定值一致：清掉该格的候选累计
        this.pending[i] = v
        this.hits[i] = 0
        continue
      }
      if (v === this.pending[i]) {
        const h = this.hits[i]! + 1
        if (h >= this.needFrames) {
          s[i] = v
          this.hits[i] = 0
        } else {
          this.hits[i] = h
        }
      } else {
        this.pending[i] = v
        this.hits[i] = 1
      }
    }
    return s.slice()
  }

  /** 当前稳定局面（诊断用；未冷启动时为 null） */
  get current(): Uint8Array | null {
    return this.stable
  }
}
