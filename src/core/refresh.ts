export interface RefreshLoopOptions {
    /** 首次重试延迟（毫秒） */
    initialDelay: number
    /** 最大延迟（毫秒） */
    maxDelay: number
    /** 退避系数，默认 1.8 */
    factor?: number
    /** 返回 true 表示成功，停止重试 */
    attempt: () => Promise<boolean>
    /** 定时器注入（插件里传 ctx.setTimeout），返回取消函数 */
    schedule: (task: () => void, delay: number) => () => void
    onRetry?: (delay: number) => void
    onError?: (error: unknown) => void
}

/**
 * 「TTS 后端比 Koishi 启动慢」的兜底：拉讲者失败后按指数退避一直重试，
 * 成功即停。所有定时器都通过 `schedule` 注入，插件卸载时可以一次性取消。
 */
export class RefreshLoop {
    private cancel?: () => void
    private stopped = true
    private delay: number

    constructor(private readonly options: RefreshLoopOptions) {
        this.delay = Math.max(1000, options.initialDelay)
    }

    get running(): boolean {
        return !this.stopped
    }

    start(): void {
        if (!this.stopped) return
        this.stopped = false
        this.delay = Math.max(1000, this.options.initialDelay)
        void this.tick()
    }

    stop(): void {
        this.stopped = true
        this.cancel?.()
        this.cancel = undefined
    }

    private async tick(): Promise<void> {
        if (this.stopped) return

        let ok = false
        try {
            ok = await this.options.attempt()
        } catch (error) {
            this.options.onError?.(error)
        }

        if (this.stopped) return
        if (ok) {
            this.stop()
            return
        }

        this.delay = Math.min(
            this.options.maxDelay,
            Math.round(this.delay * (this.options.factor ?? 1.8))
        )
        this.options.onRetry?.(this.delay)
        this.cancel = this.options.schedule(() => {
            void this.tick()
        }, this.delay)
    }
}
