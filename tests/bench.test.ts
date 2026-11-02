import { describe, expect, it } from 'vitest'
import { Pipeline } from '../src/core/pipeline'
import {
    createStubHttp,
    makeConfig,
    silentLogger,
    simpleBackend,
    wav
} from './helpers'

describe('Pipeline.bench', () => {
    it('按长度阶梯测速，样本写回 estimator', async () => {
        let clock = 0
        const config = makeConfig({ backends: [simpleBackend()] })
        const { http, calls } = createStubHttp((call) => {
            const text = String((call.body as FormData).get('text') ?? '')
            clock += 100 + text.length * 10
            return wav(0.1)
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends,
            now: () => clock
        })

        const reports = await pipeline.bench(undefined, undefined, 2)

        expect(calls).toHaveLength(6)
        expect(reports).toHaveLength(1)
        expect(reports[0].points.map((point) => point.chars)).toEqual([
            6, 12, 24
        ])
        expect(reports[0].points.every((point) => point.samples === 2)).toBe(
            true
        )
        expect(reports[0].samples).toBe(6)
        expect(reports[0].b).toBeGreaterThan(0)
        expect(reports[0].suggestedTimeout).toBeGreaterThan(0)
    })

    it('没有讲者的后端跳过并标注原因', async () => {
        const config = makeConfig({
            backends: [
                {
                    ...(simpleBackend() as any),
                    speakers: []
                }
            ]
        })
        const { http } = createStubHttp()
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const reports = await pipeline.bench()

        expect(reports[0].skipped).toBe('没有可用讲者')
        expect(reports[0].points).toHaveLength(0)
    })

    it('后端过滤只测匹配项', async () => {
        const config = makeConfig({
            backends: [
                simpleBackend({ label: 'a' } as any),
                {
                    ...(simpleBackend({ label: 'b' } as any) as any),
                    url: 'http://127.0.0.1:23457'
                }
            ]
        })
        const { http } = createStubHttp(() => wav(0.1))
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const reports = await pipeline.bench('b', undefined, 1)

        expect(reports).toHaveLength(1)
        expect(reports[0].label).toBe('b')
    })

    it('失败样本不参与拟合但仍计入失败数', async () => {
        const config = makeConfig({ backends: [simpleBackend()] })
        let index = 0
        const { http } = createStubHttp(() => {
            index += 1
            if (index === 1) {
                const error = new Error('boom') as Error & { status: number }
                error.status = 500
                throw error
            }
            return wav(0.1)
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const reports = await pipeline.bench(undefined, undefined, 1)

        expect(reports[0].points[0].failed).toBe(1)
        expect(reports[0].points[0].samples).toBe(0)
        expect(reports[0].points[1].samples).toBe(1)
    })
})
