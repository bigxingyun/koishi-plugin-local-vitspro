import { describe, expect, it } from 'vitest'
import {
    canonicalType,
    inferBackendType,
    normalizeBackends
} from '../src/core/backend-config'
import { Pipeline } from '../src/core/pipeline'
import { createStubHttp, makeConfig, wav } from './helpers'
import { LoggerLike } from '../src/types'

describe('canonicalType', () => {
    it('接受常见写法与大小写', () => {
        expect(canonicalType('vits')).toBe('vits-simple-api')
        expect(canonicalType('VITS-SIMPLE-API')).toBe('vits-simple-api')
        expect(canonicalType('gpt-sovits')).toBe('GPT-SoVITS2')
        expect(canonicalType('GPT_SOVITS')).toBe('GPT-SoVITS2')
        expect(canonicalType('fish')).toBe('fish-audio')
        expect(canonicalType('qq')).toBe('qq-voice')
        expect(canonicalType('wat')).toBeUndefined()
        expect(canonicalType(undefined)).toBeUndefined()
    })
})

describe('inferBackendType', () => {
    it('有 url 视为 vits-simple-api', () => {
        expect(inferBackendType({ url: 'http://x' })).toBe('vits-simple-api')
    })

    it('有参考音频字段视为 GPT-SoVITS', () => {
        expect(
            inferBackendType({
                url: 'http://x',
                speakers: [{ name: 'a', ref_audio_path: 'a.wav' }]
            })
        ).toBe('GPT-SoVITS2')
        expect(
            inferBackendType({ url: 'http://x', apiVersion: 'v2' })
        ).toBe('GPT-SoVITS2')
    })

    it('accountId → qq-voice；reference_id → fish', () => {
        expect(inferBackendType({ accountId: '1' })).toBe('qq-voice')
        expect(
            inferBackendType({
                baseUrl: 'http://api',
                speakers: [{ reference_id: 'r' }]
            })
        ).toBe('fish-audio')
    })

    it('什么都没有时无法推断', () => {
        expect(inferBackendType({})).toBeUndefined()
    })
})

describe('normalizeBackends', () => {
    it('缺少 type 时按 url 补成 vits-simple-api 并给出说明', () => {
        const result = normalizeBackends([
            { url: 'http://127.0.0.1:23456', username: 'u', password: 'p' }
        ])

        expect(result.backends).toHaveLength(1)
        expect(result.backends[0].type).toBe('vits-simple-api')
        expect((result.backends[0] as any).username).toBe('u')
        expect(result.issues[0]).toContain('推断为 vits-simple-api')
    })

    it('缺少 type 但带 GPT 字段时补成 GPT-SoVITS2', () => {
        const result = normalizeBackends([
            {
                url: 'http://127.0.0.1:9880',
                speakers: [{ name: '丛雨', ref_audio_path: 'a.wav' }]
            }
        ])

        expect(result.backends[0].type).toBe('GPT-SoVITS2')
        expect(result.issues[0]).toContain('GPT-SoVITS2')
    })

    it('补齐 enabled 与 speakers 默认值', () => {
        const result = normalizeBackends([{ type: 'vits', url: 'http://x' }])
        const backend = result.backends[0] as any

        expect(backend.enabled).toBe(true)
        expect(backend.speakers).toEqual([])
        expect(result.issues).toHaveLength(0)
    })

    it('type 写错但能推断时纠正', () => {
        const result = normalizeBackends([
            { type: 'vitsxx', url: 'http://x' }
        ])

        expect(result.backends[0].type).toBe('vits-simple-api')
        expect(result.issues[0]).toContain('原值 vitsxx 无法识别')
    })

    it('缺少 url 的 url 型后端被剔除并说明', () => {
        const result = normalizeBackends([{ type: 'vits-simple-api' }])

        expect(result.backends).toHaveLength(0)
        expect(result.issues[0]).toContain('缺少 url')
    })

    it('fish 缺 apiKey 被剔除', () => {
        const result = normalizeBackends([{ type: 'fish-audio' }])

        expect(result.backends).toHaveLength(0)
        expect(result.issues[0]).toContain('缺少 apiKey')
    })

    it('完全无法识别的条目被剔除', () => {
        const result = normalizeBackends([{ foo: 'bar' }, 'oops'])

        expect(result.backends).toHaveLength(0)
        expect(result.issues).toHaveLength(2)
    })
})

describe('Pipeline 对坏配置的健壮性', () => {
    it('未知 type 不会静默跳过，也不拖垮其它后端', async () => {
        const warnings: string[] = []
        const logger: LoggerLike = {
            debug: () => undefined,
            info: () => undefined,
            warn: (...args: any[]) => warnings.push(args.join(' ')),
            error: () => undefined
        }

        const config = makeConfig({
            backends: [
                {
                    type: 'not-a-backend',
                    label: '坏的',
                    url: 'http://bad',
                    speakers: []
                } as any,
                {
                    type: 'vits-simple-api',
                    label: '好的',
                    url: 'http://127.0.0.1:23456',
                    autoPullSpeaker: false,
                    speakers: [{ name: '银狼', id: 0, languages: ['ZH'] }]
                } as any
            ]
        })

        const { http } = createStubHttp(() => wav(0.1))
        const pipeline = new Pipeline({
            http,
            logger,
            config,
            backends: () => config.backends
        })

        const voices = await pipeline.ensureVoices()

        expect(voices).toHaveLength(1)
        expect(voices[0].key).toBe('好的/银狼_ZH')
        expect(
            warnings.some((line) => line.includes('未知后端类型 not-a-backend'))
        ).toBe(true)
    })

    it('手动配置缺少 type 时，plugin 层归一化后仍能工作', async () => {
        const { normalizeBackends } = await import('../src/core/backend-config')
        const raw = [{ url: 'http://127.0.0.1:23456', speakers: [] }]
        const normalized = normalizeBackends(raw)

        const config = makeConfig({
            backends: normalized.backends,
            defaultSpeaker: ''
        })
        const { http } = createStubHttp((call) =>
            call.url.endsWith('/voice/speakers')
                ? { VITS: [{ id: 0, name: '银狼', lang: ['zh'] }] }
                : wav(0.1)
        )
        // 该后端没有 autoPullSpeaker 字段 → 默认 true，会去拉讲者
        const pipeline = new Pipeline({
            http,
            logger: {
                debug: () => undefined,
                info: () => undefined,
                warn: () => undefined,
                error: () => undefined
            },
            config,
            backends: () => config.backends
        })

        const voices = await pipeline.ensureVoices(true)

        expect(voices.length).toBeGreaterThan(0)
        expect(voices[0].key).toContain('银狼')
    })
})
