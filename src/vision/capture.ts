// 屏幕捕获：getDisplayMedia 授权 → video 播放 → 定时抽帧为 ImageBitmap
//
// 合规边界（见附录 B）：只读捕获用户显式选择的窗口/标签页，不注入、不模拟输入、不自动走子。
// 抽帧用递归 setTimeout（不是 setInterval）—— 上一帧未交付完就不再排队，避免慢环境堆积。

export interface CaptureHandlers {
  /** 抽帧回调；bitmap 所有权移交调用方（需自行 close） */
  onFrame: (bitmap: ImageBitmap, frameW: number, frameH: number) => void
  /** 用户点了浏览器「停止共享」，或流被系统中断 */
  onEnded: () => void
  onError: (message: string) => void
}

export interface CaptureOptions {
  /** 抽帧间隔，默认 800ms（识别一轮含推理约 100-600ms） */
  intervalMs?: number
}

export class ScreenCapture {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private timer: number | null = null
  private active = false

  constructor(
    private readonly handlers: CaptureHandlers,
    private readonly options: CaptureOptions = {},
  ) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  }

  get intervalMs(): number {
    return this.options.intervalMs ?? 800
  }

  get mediaStream(): MediaStream | null {
    return this.stream
  }

  get sourceInfo(): { label: string; displaySurface: string } | null {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return null
    const settings = track.getSettings()
    const label = track.label || '未知来源'
    const surface = (settings.displaySurface as string) || 'unknown'
    return { label, displaySurface: surface }
  }

  /** 请求授权并开始抽帧。用户取消授权时抛 NotFoundError/NotAllowedError（由调用方分类提示） */
  async start(): Promise<void> {
    if (!ScreenCapture.isSupported()) throw new Error('当前浏览器不支持屏幕捕获（getDisplayMedia）')
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 }, // 抽帧频率远低于此，限制帧率只为降低编码开销
      audio: false,
    })
    this.stream = stream

    // 用户随时可能点浏览器的「停止共享」
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (this.active) {
          this.stop()
          this.handlers.onEnded()
        }
      })
    }

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    this.video = video
    try {
      await video.play()
    } catch (e) {
      this.stop()
      throw new Error(`屏幕流播放失败：${e instanceof Error ? e.message : String(e)}`)
    }

    this.active = true
    this.schedule()
  }

  stop(): void {
    this.active = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.video !== null) {
      this.video.pause()
      this.video.srcObject = null
      this.video = null
    }
    if (this.stream !== null) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }

  private schedule(): void {
    if (!this.active) return
    this.timer = window.setTimeout(() => {
      void this.tick()
    }, this.intervalMs)
  }

  private async tick(): Promise<void> {
    if (!this.active) return
    const stream = this.stream
    if (stream !== null && !stream.active) {
      // 浏览器停止共享后 ended 事件通常可靠，但个别环境可能丢失；
      // 周期检测 active 可保证 UI 不会一直停在「识别中」。
      this.stop()
      this.handlers.onEnded()
      return
    }
    const video = this.video
    if (video !== null && video.readyState >= 2 && video.videoWidth > 0) {
      try {
        const bitmap = await createImageBitmap(video)
        this.handlers.onFrame(bitmap, video.videoWidth, video.videoHeight)
      } catch (e) {
        this.handlers.onError(`抽帧失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.schedule()
  }
}