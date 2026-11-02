import { BreakerConfig, ErrorClass } from '../types'

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerCheck {
    allowed: boolean
    state: BreakerState
    /** true 表示这次请求充当半开探测（只放一个） */
    probe: boolean
    remainingMs?: number
    reason?: string
}

export interface BreakerView {
    state: BreakerState
    failures: number
    openUntil: number
    cooldown: number
    lastErrorClass?: ErrorClass
}

export interface BreakerOptions extends BreakerConfig {
    now?: () => number
}

interface Entry {
    failures: number
    openUntil: number
    cooldown: number
    probing: boolean
    permanent: boolean
    lastErrorClass?: ErrorClass
}

const DEFAULT_OPTIONS: BreakerConfig = {
    mode: 'auto',
    scope: 'backend',
    failureThreshold: 2,
    cooldown: 30000,
    maxCooldown: 600000
}

/**
 * 每后端（或每讲者）一份状态机：
 *
 *   closed --连续 N 次失败 / AUTH--> open --冷却到期--> half-open
 *   half-open --探测成功--> closed
 *   half-open --探测失败--> open（auto 模式冷却 ×2，封顶 maxCooldown）
 */
export class Breaker {
    private readonly entries = new Map<string, Entry>()
    private readonly options: BreakerConfig
    private readonly now: () => number

    constructor(options?: Partial<BreakerOptions>) {
        const merged: BreakerOptions = { ...DEFAULT_OPTIONS, ...options }
        this.now = merged.now ?? (() => Date.now())
        this.options = {
            mode: merged.mode,
            scope: merged.scope,
            failureThreshold: Math.max(1, merged.failureThreshold),
            cooldown: Math.max(0, merged.cooldown),
            maxCooldown: Math.max(merged.cooldown, merged.maxCooldown)
        }
    }

    canRequest(key: string): BreakerCheck {
        if (this.options.mode === 'off') {
            return { allowed: true, state: 'closed', probe: false }
        }

        const entry = this.entries.get(key)
        if (!entry) {
            return { allowed: true, state: 'closed', probe: false }
        }

        const now = this.now()

        if (entry.permanent) {
            return {
                allowed: false,
                state: 'open',
                probe: false,
                remainingMs: Number.POSITIVE_INFINITY,
                reason: 'AUTH'
            }
        }

        if (entry.openUntil > now) {
            return {
                allowed: false,
                state: 'open',
                probe: false,
                remainingMs: entry.openUntil - now,
                reason: entry.lastErrorClass ?? 'UNKNOWN'
            }
        }

        if (entry.failures >= this.options.failureThreshold) {
            if (entry.probing) {
                return {
                    allowed: false,
                    state: 'half-open',
                    probe: false,
                    remainingMs: 1,
                    reason: 'PROBING'
                }
            }
            entry.probing = true
            return { allowed: true, state: 'half-open', probe: true }
        }

        return { allowed: true, state: 'closed', probe: false }
    }

    recordSuccess(key: string): void {
        this.entries.delete(key)
    }

    recordFailure(key: string, errorClass: ErrorClass): void {
        if (this.options.mode === 'off') return

        const entry: Entry = this.entries.get(key) ?? {
            failures: 0,
            openUntil: 0,
            cooldown: this.options.cooldown,
            probing: false,
            permanent: false,
            lastErrorClass: undefined
        }

        entry.failures += 1
        entry.probing = false
        entry.lastErrorClass = errorClass

        if (errorClass === 'AUTH') {
            // 鉴权错误重试无意义，直接永久熔断，等配置变更或 `tts on`
            entry.permanent = true
            this.entries.set(key, entry)
            return
        }

        if (errorClass === 'BAD_REQUEST') {
            // 参数/讲者配错不是可用性问题，不熔断
            this.entries.set(key, entry)
            return
        }

        if (entry.failures < this.options.failureThreshold) {
            this.entries.set(key, entry)
            return
        }

        this.open(entry)
        this.entries.set(key, entry)
    }

    /** 半开探测失败（不重复计失败次数） */
    recordProbeFailure(key: string): void {
        const entry = this.entries.get(key)
        if (!entry) return
        entry.probing = false
        entry.failures = Math.max(entry.failures, this.options.failureThreshold)
        this.open(entry)
        this.entries.set(key, entry)
    }

    /** 用当前冷却开闸，auto 模式下把下次冷却翻倍 */
    private open(entry: Entry): void {
        entry.openUntil = this.now() + entry.cooldown
        if (this.options.mode === 'auto') {
            entry.cooldown = Math.min(
                this.options.maxCooldown,
                Math.max(this.options.cooldown, entry.cooldown * 2)
            )
        }
    }

    view(key: string): BreakerView {
        const entry = this.entries.get(key)
        if (!entry) {
            return {
                state: 'closed',
                failures: 0,
                openUntil: 0,
                cooldown: this.options.cooldown
            }
        }
        const now = this.now()
        let state: BreakerState = 'closed'
        if (entry.permanent || entry.openUntil > now) state = 'open'
        else if (entry.failures >= this.options.failureThreshold)
            state = 'half-open'

        return {
            state,
            failures: entry.failures,
            openUntil: entry.openUntil,
            cooldown: entry.cooldown,
            lastErrorClass: entry.lastErrorClass
        }
    }

    reset(key?: string): void {
        if (key == null) this.entries.clear()
        else this.entries.delete(key)
    }
}

