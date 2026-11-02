import { describe, expect, it } from 'vitest'
import { Pipeline } from '../src/core/pipeline'
import { RefreshLoop } from '../src/core/refresh'
import {
    createStubHttp,
    makeConfig,
    silentLogger,
    simpleBackend,
    wav
} from './helpers'

function setup(autoPull = true) {
    const state = { online: false, t: 0 }
    const { http, calls } = createStubHttp((call) => {
        if (call.url.endsWith('/voice/speakers')) {
            if (!state.online) {
                const error = new Error('connect refused') as Error & {
                    code: string
                }
                error.code = 'ECONNREFUSED'
                throw error
            }
            return { VITS: [{ name: '派蒙', id: 0, lang: ['zh'] }] }
        }
        return wav(0.2)
    })

    const config = makeConfig({
        backends: [
            simpleBackend({
                autoPullSpeaker: autoPull,
                speakers: []
            } as any)
        ]
    })

    const pipeline = new Pipeline({
        http,
        logger: silentLogger,
        config,
        backends: () => config.backends,
        now: () => state.t
    })

    const speakerCalls = () =>
        calls.filter((call) => call.url.endsWith('/voice/speakers')).length

    return { pipeline, state, speakerCalls }
}

describe('讲者列表的启动竞态', () => {
    it('后端未启动时拉不到讲者，但不能把空列表当成加载成功', async () => {
        const { pipeline } = setup()

        const voices = await pipeline.ensureVoices()

        expect(voices).toHaveLength(0)
        expect(pipeline.needsRefresh()).toBe(true)
    })

    it('后端就绪后 refreshVoices 能补上，且状态回到正常', async () => {
        const { pipeline, state } = setup()

        await pipeline.ensureVoices()
        expect(pipeline.needsRefresh()).toBe(true)

        state.online = true
        const voices = await pipeline.refreshVoices()

        expect(voices).toHaveLength(1)
        expect(voices[0].key).toBe('test/派蒙_ZH')
        expect(pipeline.needsRefresh()).toBe(false)
    })

    it('冷却期内的强制刷新不会反复打后端', async () => {
        const { pipeline, speakerCalls } = setup()

        await pipeline.ensureVoices()
        expect(speakerCalls()).toBe(1)

        await pipeline.ensureVoices(true)
        await pipeline.ensureVoices(true)

        expect(speakerCalls()).toBe(1)
    })

    it('同一时刻的并发调用只发一次请求', async () => {
        const { pipeline, speakerCalls } = setup()

        await Promise.all([
            pipeline.ensureVoices(),
            pipeline.ensureVoices(),
            pipeline.ensureVoices()
        ])

        expect(speakerCalls()).toBe(1)
    })

    it('后端晚于插件启动：第一条消息拿不到讲者，恢复后下一条能出声', async () => {
        const { pipeline, state } = setup()
        const session = { send: async () => undefined }

        const first = await pipeline.say({
            input: '你好。',
            speaker_id: 0,
            session
        })
        expect(first.type).toBe('text')

        state.online = true
        state.t += 6000

        const second = await pipeline.say({
            input: '你好。',
            speaker_id: 0,
            session
        })
        expect(second.type).toBe('audio')
    })

    it('讲者列表会在 TTL 之后自动刷新（感知后端新增讲者）', async () => {
        const { pipeline, state, speakerCalls } = setup()
        state.online = true

        await pipeline.ensureVoices()
        expect(speakerCalls()).toBe(1)

        state.t += 61_000
        await pipeline.ensureVoices()

        expect(speakerCalls()).toBe(2)
    })

    it('配置了固定讲者时，拉取失败仍能用配置里的讲者', async () => {        const state = { t: 0 }
        const { http } = createStubHttp((call) => {
            if (call.url.endsWith('/voice/speakers')) {
                const error = new Error('refused') as Error & { code: string }
                error.code = 'ECONNREFUSED'
                throw error
            }
            return wav(0.2)
        })
        const config = makeConfig({
            backends: [
                {
                    ...(simpleBackend({ autoPullSpeaker: true } as any) as any),
                    speakers: [
                        {
                            name: '本地',
                            id: 0,
                            type: 'VITS',
                            languages: ['ZH']
                        }
                    ]
                }
            ]
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends,
            now: () => state.t
        })

        const voices = await pipeline.ensureVoices()

        expect(voices).toHaveLength(1)
        expect(voices[0].name).toBe('本地')
        // 没拉全，仍要继续重试（把远端讲者补齐）
        expect(pipeline.needsRefresh()).toBe(true)
    })

    it('不支持自动拉取的后端：讲者为空也不算“没拉全”，不会无限重试', async () => {
        const { http } = createStubHttp(() => ({
            message: 'success'
        }))
        const config = makeConfig({
            backends: [
                {
                    type: 'GPT-SoVITS2',
                    label: '本地',
                    url: 'http://127.0.0.1:9880',
                    speakers: []
                } as any
            ]
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const voices = await pipeline.ensureVoices()

        expect(voices).toHaveLength(0)
        expect(pipeline.needsRefresh()).toBe(false)
    })
})

describe('RefreshLoop', () => {
    async function flush() {
        await new Promise((resolve) => setTimeout(resolve, 0))
    }

    it('失败后按退避重试，成功即停', async () => {
        const delays: number[] = []
        const tasks: (() => void)[] = []
        let attempts = 0

        const loop = new RefreshLoop({
            initialDelay: 1000,
            maxDelay: 4000,
            factor: 2,
            attempt: async () => {
                attempts += 1
                return attempts >= 3
            },
            schedule: (task, delay) => {
                delays.push(delay)
                tasks.push(task)
                return () => undefined
            }
        })

        loop.start()
        await flush()
        expect(attempts).toBe(1)

        tasks.shift()!()
        await flush()
        expect(attempts).toBe(2)

        tasks.shift()!()
        await flush()
        expect(attempts).toBe(3)

        // 第三次成功，不再安排重试
        expect(loop.running).toBe(false)
        expect(delays).toEqual([2000, 4000])
    })

    it('stop 之后不再重试', async () => {
        let attempts = 0
        const loop = new RefreshLoop({
            initialDelay: 1000,
            maxDelay: 4000,
            attempt: async () => {
                attempts += 1
                return false
            },
            schedule: () => () => undefined
        })

        loop.start()
        await flush()
        loop.stop()
        await flush()

        expect(attempts).toBe(1)
        expect(loop.running).toBe(false)
    })

    it('attempt 抛错时继续退避重试', async () => {
        let attempts = 0
        const loop = new RefreshLoop({
            initialDelay: 1000,
            maxDelay: 4000,
            attempt: async () => {
                attempts += 1
                if (attempts === 1) throw new Error('boom')
                return true
            },
            schedule: (task) => {
                void task()
                return () => undefined
            }
        })

        loop.start()
        await flush()

        expect(attempts).toBe(2)
        expect(loop.running).toBe(false)
    })
})
