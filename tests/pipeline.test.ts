import type { ElementLike } from '../src/core/element'
import { describe, expect, it } from 'vitest'
import { Pipeline } from '../src/core/pipeline'
import { wavDurationSeconds } from '../src/core/wav'
import {
    characterVoiceMessage,
    createStubHttp,
    makeConfig,
    sentenceOfLength,
    silentLogger,
    simpleBackend,
    wav
} from './helpers'
import type { Config } from '../src/config'

function splitOptions(maxSegmentChars = 40) {
    return {
        mode: 'zh_period' as const,
        allowFallback: true,
        minSegmentChars: 8,
        maxSegmentChars,
        maxSegments: 8,
        concurrency: 2
    }
}

function setup(
    overrides: Partial<Config> = {},
    handler?: Parameters<typeof createStubHttp>[0]
) {
    const config = makeConfig({
        backends: [simpleBackend()],
        split: splitOptions(),
        ...overrides
    })
    const { http, calls } = createStubHttp(handler)
    const pipeline = new Pipeline({
        http,
        logger: silentLogger,
        config,
        backends: () => config.backends
    })

    return { config, calls, pipeline }
}

function audioOf(element: ElementLike): Buffer {
    const src = String((element.attrs as any).src ?? '')
    const base64 = src.split('base64,')[1] ?? ''
    return Buffer.from(base64, 'base64')
}

describe('Pipeline.say', () => {
    it('把序列化的长句切片后拼成一条语音', async () => {
        const { pipeline, calls } = setup({}, () => wav(0.2))
        const text = sentenceOfLength(120)

        const element = await pipeline.say({
            input: characterVoiceMessage(text),
            session: {}
        })

        expect(element.type).toBe('audio')
        expect(calls.length).toBe(4)

        const sentTexts = calls.map((call) =>
            String((call.body as FormData).get('text'))
        )
        expect(sentTexts.join('')).toBe(text)
        expect(sentTexts.every((item) => !item.includes('<'))).toBe(true)

        expect(wavDurationSeconds(audioOf(element))).toBeCloseTo(0.8, 1)
    })

    it('工具路径：太短直接抛 VitsDegradeError，不发请求', async () => {
        const { pipeline, calls } = setup()

        await expect(
            pipeline.say({ input: characterVoiceMessage('嗯') })
        ).rejects.toMatchObject({ code: 'TOO_SHORT' })

        expect(calls).toHaveLength(0)
    })

    it('工具路径：太长直接抛 VitsDegradeError', async () => {
        const { pipeline, calls } = setup()

        await expect(
            pipeline.say({
                input: characterVoiceMessage(sentenceOfLength(400))
            })
        ).rejects.toMatchObject({ code: 'TOO_LONG' })

        expect(calls).toHaveLength(0)
    })

    it('服务路径：降级时回纯文本而不是抛错', async () => {
        const { pipeline, calls } = setup()

        const element = await pipeline.say({
            input: sentenceOfLength(2100),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(String(element.attrs.content)).toHaveLength(2100)
        expect(calls).toHaveLength(0)
    })

    it('空输入降级为文字（服务路径）', async () => {
        const { pipeline, calls } = setup()

        const element = await pipeline.say({
            input: '',
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(calls).toHaveLength(0)
    })

    it('连续失败后熔断，后续调用不再发请求', async () => {
        const failing = () => {
            const error = new Error('connect refused') as Error & {
                code: string
            }
            error.code = 'ECONNREFUSED'
            throw error
        }
        const { pipeline, calls } = setup(
            {
                breaker: {
                    mode: 'auto',
                    scope: 'backend',
                    failureThreshold: 1,
                    cooldown: 30000,
                    maxCooldown: 600000
                }
            },
            failing
        )

        await expect(
            pipeline.say({ input: characterVoiceMessage(sentenceOfLength(60)) })
        ).rejects.toMatchObject({ code: 'ALL_SEGMENTS_FAILED' })

        const callsAfterFailure = calls.length

        await expect(
            pipeline.say({ input: characterVoiceMessage(sentenceOfLength(60)) })
        ).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' })

        expect(calls.length).toBe(callsAfterFailure)
    })

    it('aggregate=multi 时首段返回、其余段补发', async () => {
        const { pipeline } = setup({
            split: splitOptions(20),
            aggregate: {
                type: 'multi',
                maxAudioSeconds: 55,
                partialPolicy: 'keep-ok'
            }
        })
        const sent: ElementLike[] = []
        const session = {
            send: async (element: ElementLike) => {
                sent.push(element)
            }
        }

        const element = await pipeline.say({
            input: characterVoiceMessage(sentenceOfLength(45)),
            session
        })

        expect(element.type).toBe('audio')
        expect(sent).toHaveLength(2)
        expect(sent.every((item) => item.type === 'audio')).toBe(true)
    })

    it('降级提示按间隔节流', async () => {
        const failing = () => {
            const error = new Error('connect refused') as Error & {
                code: string
            }
            error.code = 'ECONNREFUSED'
            throw error
        }
        const { pipeline } = setup(
            {
                breaker: {
                    mode: 'auto',
                    scope: 'backend',
                    failureThreshold: 1,
                    cooldown: 30000,
                    maxCooldown: 600000
                }
            },
            failing
        )
        const notices: string[] = []
        const session = {
            send: async (message: string) => {
                notices.push(String(message))
            }
        }

        await expect(
            pipeline.say({
                input: characterVoiceMessage(sentenceOfLength(30)),
                session
            })
        ).rejects.toBeTruthy()

        await expect(
            pipeline.say({
                input: characterVoiceMessage(sentenceOfLength(30)),
                session
            })
        ).rejects.toBeTruthy()

        expect(notices).toHaveLength(1)
        expect(notices[0]).toContain('语音暂不可用')
    })

    it('tts off 后直接降级', async () => {
        const { pipeline, calls } = setup()
        pipeline.setEnabled(false)

        const element = await pipeline.say({
            input: sentenceOfLength(20),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(calls).toHaveLength(0)
    })

    it('缺少讲者时降级', async () => {
        const config = makeConfig({
            backends: [
                {
                    ...(simpleBackend() as any),
                    speakers: []
                }
            ]
        })
        const { http, calls } = createStubHttp()
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const element = await pipeline.say({
            input: sentenceOfLength(20),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(calls).toHaveLength(0)
    })

    it('超过平台时长上限时降级', async () => {
        const { pipeline, calls } = setup({
            aggregate: {
                type: 'auto',
                maxAudioSeconds: 1,
                partialPolicy: 'keep-ok'
            }
        })

        const element = await pipeline.say({
            input: sentenceOfLength(20),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(calls).toHaveLength(0)
    })
})

describe('Pipeline.explain', () => {
    it('输出归一化、切片、决策与超时', async () => {
        const { pipeline } = setup()
        const info = await pipeline.explain(
            characterVoiceMessage(sentenceOfLength(60))
        )

        expect(info.hadMarkup).toBe(true)
        expect(info.source).toBe('tool')
        expect(info.chars).toBe(52)
        expect(info.decision.action).toBe('voice')
        expect(info.voice).toBe('test/测试_ZH')
        expect(info.segments.length).toBeGreaterThan(1)
        expect(info.timeout).toBeGreaterThan(0)
    })

    it('manual 模式使用固定超时', async () => {
        const { pipeline } = setup({
            timeout: {
                mode: 'manual',
                manual: 1234,
                factor: 2,
                min: 5000,
                max: 120000,
                overhead: 800,
                coldStart: 30000
            }
        })

        const info = await pipeline.explain('你好世界')

        expect(info.timeout).toBe(1234)
    })

    it('没有测速样本时用冷启动预算（避免首句被误杀）', async () => {
        const { pipeline } = setup()

        const info = await pipeline.explain('你好世界')

        expect(info.timeout).toBe(30000)
    })

    it('样本足够后切回动态公式', async () => {
        const { pipeline } = setup()
        for (const [chars, ms] of [
            [10, 1000],
            [20, 1800],
            [30, 2600],
            [40, 3400]
        ]) {
            pipeline.estimator.record('test:vits-simple-api', chars, ms)
        }

        const info = await pipeline.explain('你好世界')

        // 4 字：a≈200 + b≈80×4 = 520 → ×2 + 800 = 1840 → 夹到下限 5000
        expect(info.timeout).toBe(5000)
    })
})

describe('Pipeline.status', () => {
    it('给出后端状态与建议超时', async () => {
        const { pipeline } = setup()
        const status = await pipeline.status()

        expect(status).toHaveLength(1)
        expect(status[0].speakers).toBe(1)
        expect(status[0].state).toBe('closed')
        expect(status[0].suggestedTimeout).toBeGreaterThan(0)
    })
})

describe('默认 WAV 内容', () => {
    it('默认 handler 返回合法 WAV', () => {
        expect(wavDurationSeconds(wav(1))).toBeCloseTo(1, 2)
    })
})


