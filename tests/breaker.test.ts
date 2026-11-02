import { describe, expect, it } from 'vitest'
import { Breaker } from '../src/core/breaker'

function clock(start = 1_000_000) {
    let now = start
    return {
        now: () => now,
        advance: (ms: number) => {
            now += ms
        }
    }
}

describe('Breaker', () => {
    it('连续失败达到阈值才熔断', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 2,
            cooldown: 1000,
            now: c.now
        })

        breaker.recordFailure('a', 'CONNECT')
        expect(breaker.canRequest('a').allowed).toBe(true)

        breaker.recordFailure('a', 'CONNECT')
        const check = breaker.canRequest('a')
        expect(check.allowed).toBe(false)
        expect(check.state).toBe('open')
        expect(check.remainingMs).toBe(1000)
    })

    it('冷却到期后只放一个半开探测', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 1,
            cooldown: 1000,
            now: c.now
        })

        breaker.recordFailure('a', 'CONNECT')
        expect(breaker.canRequest('a').allowed).toBe(false)

        c.advance(1000)
        const probe = breaker.canRequest('a')
        expect(probe.allowed).toBe(true)
        expect(probe.probe).toBe(true)

        // 探测进行中，再来一个请求要被挡住
        expect(breaker.canRequest('a').allowed).toBe(false)
    })

    it('半开探测成功回到 closed', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 1,
            cooldown: 1000,
            now: c.now
        })

        breaker.recordFailure('a', 'CONNECT')
        c.advance(1000)
        breaker.canRequest('a')
        breaker.recordSuccess('a')

        expect(breaker.canRequest('a').allowed).toBe(true)
        expect(breaker.view('a').state).toBe('closed')
    })

    it('半开探测失败后冷却翻倍', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 1,
            cooldown: 1000,
            maxCooldown: 10000,
            now: c.now
        })

        breaker.recordFailure('a', 'CONNECT')
        c.advance(1000)
        breaker.canRequest('a')
        breaker.recordProbeFailure('a')

        const check = breaker.canRequest('a')
        expect(check.allowed).toBe(false)
        expect(check.remainingMs).toBe(2000)
    })

    it('auto 模式冷却翻倍，封顶 maxCooldown', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 1,
            cooldown: 1000,
            maxCooldown: 3000,
            now: c.now
        })

        breaker.recordFailure('a', 'SERVER')
        c.advance(1000)
        breaker.canRequest('a')
        breaker.recordProbeFailure('a')
        c.advance(2000)
        breaker.canRequest('a')
        breaker.recordProbeFailure('a')

        expect(breaker.canRequest('a').remainingMs).toBe(3000)
    })

    it('manual 模式冷却固定不翻倍', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'manual',
            failureThreshold: 1,
            cooldown: 1000,
            maxCooldown: 10000,
            now: c.now
        })

        breaker.recordFailure('a', 'CONNECT')
        c.advance(1000)
        breaker.canRequest('a')
        breaker.recordProbeFailure('a')

        expect(breaker.canRequest('a').remainingMs).toBe(1000)
    })

    it('AUTH 错误一次即永久熔断，reset 后恢复', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 5,
            cooldown: 1000,
            now: c.now
        })

        breaker.recordFailure('a', 'AUTH')
        const check = breaker.canRequest('a')
        expect(check.allowed).toBe(false)
        expect(check.remainingMs).toBe(Number.POSITIVE_INFINITY)

        c.advance(1_000_000)
        expect(breaker.canRequest('a').allowed).toBe(false)

        breaker.reset('a')
        expect(breaker.canRequest('a').allowed).toBe(true)
    })

    it('BAD_REQUEST 不触发熔断', () => {
        const c = clock()
        const breaker = new Breaker({
            mode: 'auto',
            failureThreshold: 1,
            cooldown: 1000,
            now: c.now
        })

        breaker.recordFailure('a', 'BAD_REQUEST')
        expect(breaker.canRequest('a').allowed).toBe(true)
    })

    it('mode=off 永不熔断', () => {
        const breaker = new Breaker({ mode: 'off', now: () => 1000 })

        breaker.recordFailure('a', 'CONNECT')
        breaker.recordFailure('a', 'CONNECT')
        breaker.recordFailure('a', 'AUTH')

        expect(breaker.canRequest('a').allowed).toBe(true)
    })
})
