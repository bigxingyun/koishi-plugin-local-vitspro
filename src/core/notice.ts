import { NoticeMode } from '../types'

export interface NoticeOptions {
    mode: NoticeMode
    /** 同一 key 的最小提示间隔（毫秒） */
    interval: number
}

/** 降级提示节流：同一后端 + 同一原因在 interval 内只提示一次 */
export class NoticeThrottle {
    private readonly last = new Map<string, number>()

    constructor(
        private readonly options: NoticeOptions,
        private readonly now: () => number = () => Date.now()
    ) {}

    get enabled(): boolean {
        return this.options.mode !== 'off'
    }

    shouldNotify(key: string): boolean {
        if (!this.enabled) return false

        const current = this.now()
        const previous = this.last.get(key)
        if (previous != null && current - previous < this.options.interval) {
            return false
        }

        this.last.set(key, current)
        return true
    }

    reset(key?: string): void {
        if (key == null) this.last.clear()
        else this.last.delete(key)
    }
}

