import { describe, expect, it } from 'vitest'
import { Estimator, median } from '../src/core/estimator'

describe('Estimator', () => {
    it('样本不足时用兜底模型', () => {
        const estimator = new Estimator()
        estimator.record('a', 10, 2000)

        const estimate = estimator.estimate('a', 60)

        expect(estimate.source).toBe('fallback')
        expect(estimate.a).toBe(800)
        expect(estimate.b).toBe(120)
    })

    it('样本足够时做线性拟合', () => {
        const estimator = new Estimator()
        // ms = 200 + 80 * chars
        for (const [chars, ms] of [
            [10, 1000],
            [20, 1800],
            [30, 2600],
            [40, 3400]
        ]) {
            estimator.record('a', chars, ms)
        }

        const estimate = estimator.estimate('a', 60)

        expect(estimate.source).toBe('fit')
        expect(estimate.a).toBeCloseTo(200, 0)
        expect(estimate.b).toBeCloseTo(80, 0)
        expect(estimator.estimateMs('a', 60)).toBeCloseTo(5000, -1)
    })

    it('异常样本被剔除', () => {
        const estimator = new Estimator()
        for (const [chars, ms] of [
            [10, 1000],
            [20, 1800],
            [30, 2600],
            [40, 3400],
            [50, 50000]
        ]) {
            estimator.record('a', chars, ms)
        }

        expect(estimator.estimate('a', 60).b).toBeLessThan(1000)
    })

    it('超时惩罚会抬高斜率，连续成功后回落', () => {
        const estimator = new Estimator()
        for (const [chars, ms] of [
            [10, 1000],
            [20, 1800],
            [30, 2600],
            [40, 3400]
        ]) {
            estimator.record('a', chars, ms)
        }

        const base = estimator.estimate('a', 60).b
        estimator.bumpPenalty('a')
        const bumped = estimator.estimate('a', 60).b
        expect(bumped).toBeGreaterThan(base)

        for (let i = 0; i < 5; i++) estimator.recordSuccess('a')
        expect(estimator.estimate('a', 60).b).toBeCloseTo(base, 3)
    })

    it('环形缓冲最多保留 ringSize 条', () => {
        const estimator = new Estimator(5)
        for (let i = 0; i < 10; i++) estimator.record('a', 10 + i, 1000 + i * 10)

        expect(estimator.count('a')).toBe(5)
    })

    it('reset 清空指定后端', () => {
        const estimator = new Estimator()
        estimator.record('a', 10, 1000)
        estimator.record('b', 10, 1000)
        estimator.reset('a')

        expect(estimator.count('a')).toBe(0)
        expect(estimator.count('b')).toBe(1)
    })

    it('median 计算', () => {
        expect(median([3, 1, 2])).toBe(2)
        expect(median([4, 1, 2, 3])).toBe(2.5)
        expect(median([])).toBe(0)
    })
})
