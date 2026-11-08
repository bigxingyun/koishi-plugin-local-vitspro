import { describe, expect, it } from 'vitest'
import { GsvApiAdapter, parseSpeakers } from '../src/adapters/gsv-api'
import {
    buildAutoBackend,
    detectBackend,
    looksLikeGsvHealth
} from '../src/core/detect'
import { canonicalType, inferBackendType } from '../src/core/backend-config'
import { createStubHttp, silentLogger, wav } from './helpers'
import { BackendError } from '../src/core/errors'

const logger = silentLogger

function backend(patch: Record<string, unknown> = {}) {
    return {
        type: 'gsv-api',
        label: 'gsv',
        url: 'http://127.0.0.1:9880',
        ...patch
    } as any
}

const speaker = {
    name: '银狼',
    id: 'yinlang',
    emotion: '平静',
    languages: ['zh']
}

const request = (text = '今天天气不错') => ({
    text,
    timeout: 5000
})

const speakersPayload = {
    object: 'list',
    api_version: '1.0',
    data: [
        {
            id: 'yinlang',
            name: '银狼',
            enabled: true,
            emotions: ['平静', '生气'],
            default_emotion: '平静',
            languages: ['zh', 'en'],
            status: 'ready'
        },
        {
            id: 'disabled-one',
            name: '停用的',
            enabled: false,
            status: 'disabled'
        }
    ]
}

describe('GSV API v1 讲者', () => {
    it('解析 /v1/speakers 并过滤停用角色', async () => {
        const { http, calls } = createStubHttp(() => speakersPayload)
        const adapter = new GsvApiAdapter({ http, logger })

        const speakers = await adapter.getSpeakers(backend())

        expect(calls[0].method).toBe('GET')
        expect(calls[0].url).toBe('http://127.0.0.1:9880/v1/speakers')
        expect(speakers.map((item) => item.name)).toEqual(['银狼'])

        const yinlang = speakers[0] as any
        expect(yinlang.id).toBe('yinlang')
        expect(yinlang.emotions).toEqual(['平静', '生气'])
        expect(yinlang.defaultEmotion).toBe('平静')
        expect(yinlang.status).toBe('ready')
    })

    it('Bearer / X-API-Key / both 三种鉴权头', async () => {
        for (const [mode, expected] of [
            ['bearer', { Authorization: 'Bearer secret' }],
            ['x-api-key', { 'X-API-Key': 'secret' }],
            [
                'both',
                {
                    Authorization: 'Bearer secret',
                    'X-API-Key': 'secret'
                }
            ]
        ] as const) {
            const { http, calls } = createStubHttp(() => speakersPayload)
            const adapter = new GsvApiAdapter({ http, logger })

            await adapter.getSpeakers(
                backend({ apiKey: 'secret', authMode: mode })
            )

            for (const [key, value] of Object.entries(expected)) {
                expect(calls[0].config?.headers?.[key]).toBe(value)
            }
        }
    })

    it('没有 apiKey 时不带鉴权头', async () => {
        const { http, calls } = createStubHttp(() => speakersPayload)
        const adapter = new GsvApiAdapter({ http, logger })

        await adapter.getSpeakers(backend())

        expect(calls[0].config?.headers?.Authorization).toBeUndefined()
    })

    it('识别嵌套 data / 纯数组两种返回', () => {
        expect(parseSpeakers(speakersPayload)).toHaveLength(1)
        expect(
            parseSpeakers([{ id: 'a', name: 'A', status: 'ready' }])
        ).toHaveLength(1)
        expect(parseSpeakers(null)).toEqual([])
    })
})

describe('GSV API v1 合成', () => {
    it('POST /v1/audio/speech，只带公开字段', async () => {
        const { http, calls } = createStubHttp(() => wav(1))
        const adapter = new GsvApiAdapter({ http, logger })

        const result = await adapter.synthesize({
            ...request(),
            backend: backend(),
            speaker
        } as any)

        expect(result.mime).toBe('audio/wav')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toBe('http://127.0.0.1:9880/v1/audio/speech')
        expect(calls[0].config?.responseType).toBe('arraybuffer')

        const body = calls[0].body as Record<string, unknown>
        expect(body.text).toBe('今天天气不错')
        expect(body.speaker).toBe('yinlang')
        expect(body.emotion).toBe('平静')
        expect(body.format).toBe('wav')
        // 不应该出现 api_v2 的字段
        expect(body.ref_audio_path).toBeUndefined()
        expect(body.top_k).toBeUndefined()
        expect(body.model).toBeUndefined()
    })

    it('language 跟随请求语言，format=ogg 时 mime 正确', async () => {
        const { http, calls } = createStubHttp(() => wav(1))
        const adapter = new GsvApiAdapter({ http, logger })

        const result = await adapter.synthesize({
            ...request(),
            backend: backend({ format: 'ogg' }),
            speaker,
            language: 'EN'
        } as any)

        expect((calls[0].body as any).language).toBe('en')
        expect((calls[0].body as any).format).toBe('ogg')
        expect(result.mime).toBe('audio/ogg')
    })

    it('讲者缺 id 时直接报 BAD_REQUEST', async () => {
        const { http } = createStubHttp(() => wav(1))
        const adapter = new GsvApiAdapter({ http, logger })

        await expect(
            adapter.synthesize({
                ...request(),
                backend: backend(),
                speaker: { name: '无 id 讲者' }
            } as any)
        ).rejects.toMatchObject({ errorClass: 'BAD_REQUEST' })
    })

    it('错误体里的 code/message 会带进异常', async () => {
        const { http } = createStubHttp(() => {
            const error = new Error('400') as any
            error.status = 422
            error.response = {
                status: 422,
                data: {
                    error: {
                        code: 'EMOTION_NOT_FOUND',
                        message: "speaker 'yinlang' has no emotion"
                    }
                }
            }
            throw error
        })
        const adapter = new GsvApiAdapter({ http, logger })

        const error = await adapter
            .synthesize({
                ...request(),
                backend: backend(),
                speaker
            } as any)
            .catch((value) => value)

        expect(error).toBeInstanceOf(BackendError)
        expect(error.message).toContain('EMOTION_NOT_FOUND')
        expect(error.status).toBe(422)
    })

    it('probeSpeakers 带 URL 与角色数', async () => {
        const { http } = createStubHttp(() => speakersPayload)
        const adapter = new GsvApiAdapter({ http, logger })

        const probe = await adapter.probeSpeakers(backend())

        expect(probe.ok).toBe(true)
        expect(probe.count).toBe(1)
        expect(probe.url).toContain('/v1/speakers')
        expect(probe.sample).toEqual(['银狼'])
    })
})

describe('GSV API v1 自动探测', () => {
    it('/v1/health 与 /v1/speakers 能识别 gsv-api', async () => {
        const { http } = createStubHttp((call) => {
            if (call.url.endsWith('/v1/health')) {
                return { status: 'ok', api_version: '1.0' }
            }
            if (call.url.endsWith('/v1/speakers')) return speakersPayload
            const error = new Error('404') as any
            error.status = 404
            throw error
        })

        const result = await detectBackend(http as any, {
            enabled: true,
            url: 'http://127.0.0.1:9880',
            label: '自动',
            username: '',
            password: '',
            apiKey: 'secret',
            token: '',
            timeout: 3000,
            backendTimeout: 0
        })

        expect(result.kind).toBe('gsv-api')
        expect(result.speakers?.map((item) => (item as any).id)).toEqual([
            'yinlang'
        ])
    })

    it('looksLikeGsvHealth 判定', () => {
        expect(looksLikeGsvHealth({ status: 'ok' })).toBe(true)
        expect(looksLikeGsvHealth({ api_version: '1.0' })).toBe(true)
        expect(looksLikeGsvHealth({ hello: 'world' })).toBe(false)
    })

    it('buildAutoBackend 生成 gsv-api 后端', () => {
        const result = buildAutoBackend(
            {
                enabled: true,
                url: 'http://127.0.0.1:9880',
                label: '自动',
                username: '',
                password: '',
                apiKey: 'secret',
                token: '',
                timeout: 3000,
                backendTimeout: 0
            },
            {
                ok: true,
                kind: 'gsv-api',
                baseUrl: 'http://127.0.0.1:9880',
                probes: [],
                speakers: [{ name: '银狼', id: 'yinlang' } as any]
            }
        ) as any

        expect(result.type).toBe('gsv-api')
        expect(result.apiKey).toBe('secret')
        expect(result.autoPullSpeaker).toBe(true)
        expect(result.speakers[0].id).toBe('yinlang')
    })
})

describe('GSV 配置推断', () => {
    it('别名与 URL 推断', () => {
        expect(canonicalType('gsv')).toBe('gsv-api')
        expect(canonicalType('GSV-API')).toBe('gsv-api')
        expect(
            inferBackendType({ url: 'http://127.0.0.1:9880/v1/audio/speech' })
        ).toBe('gsv-api')
        expect(
            inferBackendType({ url: 'http://127.0.0.1:23456' })
        ).toBe('vits-simple-api')
    })
})

