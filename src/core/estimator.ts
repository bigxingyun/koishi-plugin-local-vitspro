export type SampleSource = 'real' | 'probe'

export interface Sample {
    chars: number
    ms: number
    source: SampleSource
    at: number
}

export interface Estimate {
    /** 固定开销（毫秒） */
    a: number
    /** 每字耗时（毫秒/字） */
    b: number
    samples: number
    source: 'fit' | 'fallback'
}

const FALLBACK_A = 800
const FALLBACK_B = 120

/**
 * 每后端一份测速样本，拟合 `ms = a + b × chars`。
 * 样本不足或有异常值时退化为「每字中位数」的兜底模型。
 */
export class Estimator {
    private readonly store = new Map<string, Sample[]>()
    private readonly penalty = new Map<string, number>()
    private readonly successStreak = new Map<string, number>()

    constructor(
        private readonly ringSize = 32,
        private readonly now: () => number = () => Date.now()
    ) {}

    record(
        key: string,
        chars: number,
        ms: number,
        source: SampleSource = 'real'
    ): void {
        if (!Number.isFinite(chars) || !Number.isFinite(ms)) return
        if (chars <= 0 || ms < 0) return

        const list = this.store.get(key) ?? []
        list.push({ chars, ms, source, at: this.now() })
        if (list.length > this.ringSize) list.splice(0, list.length - this.ringSize)
        this.store.set(key, list)
    }

    samples(key: string): Sample[] {
        return [...(this.store.get(key) ?? [])]
    }

    count(key: string): number {
        return this.store.get(key)?.length ?? 0
    }

    estimate(key: string, chars: number): Estimate {
        const raw = this.store.get(key) ?? []
        const samples = dropOutliers(raw)
        const penalty = this.penalty.get(key) ?? 1

        if (samples.length < 4) {
            return {
                a: FALLBACK_A,
                b: FALLBACK_B * penalty,
                samples: raw.length,
                source: 'fallback'
            }
        }

        const xs = samples.map((s) => s.chars)
        const ys = samples.map((s) => s.ms)
        const meanX = average(xs)
        const meanY = average(ys)
        const variance = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0)

        // 字数没有差异时拟合不出斜率，退化为每字中位数
        if (variance < 1e-6) {
            const perChar = median(
                samples
                    .filter((s) => s.chars > 0)
                    .map((s) => s.ms / s.chars)
            )
            return {
                a: Math.max(0, meanY - perChar * meanX),
                b: Math.max(1, perChar * penalty),
                samples: raw.length,
                source: 'fit'
            }
        }

        const covariance = samples.reduce(
            (sum, s) => sum + (s.chars - meanX) * (s.ms - meanY),
            0
        )
        const b = covariance / variance
        const a = meanY - b * meanX

        return {
            a: Math.max(0, a),
            b: Math.max(1, b * penalty),
            samples: raw.length,
            source: 'fit'
        }
    }

    estimateMs(key: string, chars: number): number {
        const { a, b } = this.estimate(key, chars)
        return Math.max(0, Math.round(a + b * Math.max(0, chars)))
    }

    /** 超时后抬高斜率（仅当前进程），避免同一长句反复踩线 */
    bumpPenalty(key: string): void {
        const current = this.penalty.get(key) ?? 1
        this.penalty.set(key, Math.min(2, current * 1.3))
        this.successStreak.set(key, 0)
    }

    /** 连续 5 次成功后退回拟合值 */
    recordSuccess(key: string): void {
        const streak = (this.successStreak.get(key) ?? 0) + 1
        this.successStreak.set(key, streak)
        if (streak >= 5) {
            this.penalty.set(key, 1)
            this.successStreak.set(key, 0)
        }
    }

    reset(key?: string): void {
        if (key == null) {
            this.store.clear()
            this.penalty.clear()
            this.successStreak.clear()
            return
        }
        this.store.delete(key)
        this.penalty.delete(key)
        this.successStreak.delete(key)
    }
}

function dropOutliers(samples: Sample[]): Sample[] {
    if (samples.length < 4) return samples
    const med = median(samples.map((s) => s.ms))
    if (med <= 0) return samples
    return samples.filter((s) => s.ms <= med * 3)
}

export function average(values: number[]): number {
    if (values.length === 0) return 0
    return values.reduce((sum, v) => sum + v, 0) / values.length
}

export function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
}
