import { describe, expect, it } from 'vitest'
import {
    authHeaders,
    buildAutoBackend,
    detectBackend,
    normalizeBaseUrl
} from '../src/core/detect'
import { AutoConfig, HttpClient } from '../src/types'
import { Pipeline } from '../src/core/pipeline'
import { makeConfig, silentLogger, simpleBackend } from './helpers'

function autoConfig(patch: Partial<AutoConfig> = {}): AutoConfig {
    return {
        enabled: true,
        url: 'http://127.0.0.1:23456',
        label: '自动',
        username: '',
        password: '',
        apiKey: '',
        token: '',
        timeout: 3000,
        ...patch
    }
}

interface Route {
    status?: number
    data?: unknown
}

function stubHttp(routes: Record<string, Route | (() => Route)>) {
    const calls: { url: string; headers?: Record<string, string> }[] = []

    const http: HttpClient = {
        async get(url: string, config?: Record<string, any>) {
            calls.push({ url, headers: config?.headers })
            const path = new URL(url).pathname
            const route = routes[path]
            if (!route) {
                const error = new Error('not found') as Error & {
                    status: number
                }
                error.status = 404
                throw error
            }
            const value = typeof route === 'function' ? route() : route
            const status = value.status ?? 200
            if (status >= 400) {
                const error = new Error(`HTTP ${status}`) as Error & {
                    status: number
                    response: { status: number; data: unknown }
                }
                error.status = status
                error.response = { status, data: value.data }
                throw error
            }
            return value.data
        },
        async post() {
            throw new Error('not expected')
        }
    }

    return { http, calls }
}

describe('normalizeBaseUrl', () => {
    it('根地址原样保留', () => {
        expect(normalizeBaseUrl('http://127.0.0.1:23456')).toBe(
            'http://127.0.0.1:23456'
        )
    })

    it('去掉尾部斜杠与 /voice', () => {
        expect(normalizeBaseUrl('http://127.0.0.1:23456/voice/')).toBe(
            'http://127.0.0.1:23456'
        )
    })

    it('去掉完整合成端点', () => {
        expect(normalizeBaseUrl('http://127.0.0.1:23456/voice/vits')).toBe(
            'http://127.0.0.1:23456'
        )
        expect(normalizeBaseUrl('http://127.0.0.1:9880/tts')).toBe(
            'http://127.0.0.1:9880'
        )
    })

    it('缺少协议时补 http://', () => {
        expect(normalizeBaseUrl('127.0.0.1:23456')).toBe(
            'http://127.0.0.1:23456'
        )
    })
})

describe('authHeaders', () => {
    it('Basic / X-API-KEY / Bearer', () => {
        expect(
            authHeaders(autoConfig({ username: 'u', password: 'p' }))
                .Authorization
        ).toBe('Basic ' + Buffer.from('u:p').toString('base64'))

        expect(authHeaders(autoConfig({ apiKey: 'k' }))['X-API-KEY']).toBe('k')

        expect(authHeaders(autoConfig({ token: 't' })).Authorization).toBe(
            'Bearer t'
        )
    })

    it('token 优先于 Basic', () => {
        expect(
            authHeaders(
                autoConfig({ username: 'u', password: 'p', token: 't' })
            ).Authorization
        ).toBe('Bearer t')
    })
})

describe('detectBackend', () => {
    it('识别 vits-simple-api 并带出讲者', async () => {
        const { http } = stubHttp({
            '/voice/speakers': {
                data: { VITS: [{ id: 0, name: '银狼', lang: ['zh'] }] }
            }
        })

        const result = await detectBackend(http, autoConfig())

        expect(result.ok).toBe(true)
        expect(result.kind).toBe('vits-simple-api')
        expect(result.speakers?.map((item) => item.name)).toEqual(['银狼'])
        expect(result.baseUrl).toBe('http://127.0.0.1:23456')
    })

    it('识别 GPT-SoVITS v2（OpenAPI）', async () => {
        const { http } = stubHttp({
            '/openapi.json': {
                data: {
                    paths: {
                        '/tts': {},
                        '/set_gpt_weights': {},
                        '/set_sovits_weights': {}
                    }
                }
            }
        })

        const result = await detectBackend(
            http,
            autoConfig({ url: 'http://127.0.0.1:9880' })
        )

        expect(result.ok).toBe(true)
        expect(result.kind).toBe('gpt-sovits-v2')
        expect(result.hint).toContain('ref_audio_path')
    })

    it('识别 GPT-SoVITS v2（/tts 返回 422）', async () => {
        const { http } = stubHttp({
            '/tts': { status: 422, data: { detail: [] } }
        })

        const result = await detectBackend(
            http,
            autoConfig({ url: 'http://127.0.0.1:9880' })
        )

        expect(result.kind).toBe('gpt-sovits-v2')
    })

    it('识别老版 api.py（/change_refer）', async () => {
        const { http } = stubHttp({
            '/openapi.json': {
                data: { paths: { '/change_refer': {}, '/set_model': {} } }
            }
        })

        const result = await detectBackend(
            http,
            autoConfig({ url: 'http://127.0.0.1:9880' })
        )

        expect(result.kind).toBe('gpt-sovits-v1')
    })

    it('401/403 给出鉴权提示', async () => {
        const { http } = stubHttp({
            '/voice/speakers': { status: 401 },
            '/openapi.json': { status: 401 },
            '/tts': { status: 401 },
            '/': { status: 401 }
        })

        const result = await detectBackend(http, autoConfig())

        expect(result.ok).toBe(false)
        expect(result.hint).toContain('401/403')
    })

    it('全部失败时返回 unknown 并保留探测记录', async () => {
        const { http } = stubHttp({})

        const result = await detectBackend(http, autoConfig())

        expect(result.ok).toBe(false)
        expect(result.kind).toBe('unknown')
        expect(result.probes.length).toBeGreaterThan(0)
        expect(result.probes.every((probe) => probe.status === 404)).toBe(true)
    })

    it('把凭证带进每个探测请求', async () => {
        const { http, calls } = stubHttp({
            '/voice/speakers': {
                data: { VITS: [{ id: 0, name: 'a', lang: ['zh'] }] }
            }
        })

        await detectBackend(
            http,
            autoConfig({ username: 'u', password: 'p', apiKey: 'k' })
        )

        expect(calls[0].headers?.Authorization).toBe(
            'Basic ' + Buffer.from('u:p').toString('base64')
        )
        expect(calls[0].headers?.['X-API-KEY']).toBe('k')
    })
})

describe('buildAutoBackend', () => {
    it('vits-simple-api → 带讲者与自动拉取', () => {
        const backend = buildAutoBackend(autoConfig(), {
            ok: true,
            kind: 'vits-simple-api',
            baseUrl: 'http://127.0.0.1:23456',
            probes: [],
            speakers: [{ name: '银狼', languages: ['ZH'] }]
        }) as any

        expect(backend.type).toBe('vits-simple-api')
        expect(backend.autoPullSpeaker).toBe(true)
        expect(backend.speakers[0].name).toBe('银狼')
        expect(backend.username).toBeUndefined()
    })

    it('GPT-SoVITS v2 → 自动带 apiVersion', () => {
        const backend = buildAutoBackend(
            autoConfig({ url: 'http://127.0.0.1:9880' }),
            {
                ok: true,
                kind: 'gpt-sovits-v2',
                baseUrl: 'http://127.0.0.1:9880',
                probes: []
            }
        ) as any

        expect(backend.type).toBe('GPT-SoVITS2')
        expect(backend.apiVersion).toBe('v2')
        expect(backend.speakers).toEqual([])
    })

    it('探测失败不生成后端', () => {
        expect(
            buildAutoBackend(autoConfig(), {
                ok: false,
                kind: 'unknown',
                baseUrl: '',
                probes: []
            })
        ).toBeUndefined()
    })
})

describe('Pipeline 自动配置', () => {
    it('自动探测出的后端会参与讲者加载与状态', async () => {
        const config = makeConfig({
            auto: autoConfig(),
            backends: []
        })
        const { http } = stubHttp({
            '/voice/speakers': {
                data: {
                    VITS: [
                        { id: 0, name: '银狼', lang: ['zh'] },
                        { id: 1, name: '昔涟', lang: ['zh'] }
                    ]
                }
            }
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const voices = await pipeline.ensureVoices()

        expect(voices.map((voice) => voice.key).sort()).toEqual([
            '自动/昔涟_ZH',
            '自动/银狼_ZH'
        ])
        expect(pipeline.getAutoResult()?.kind).toBe('vits-simple-api')

        const status = await pipeline.status()
        expect(status).toHaveLength(1)
        expect(status[0].label).toBe('自动')
    })

    it('手动配置了同一地址时不重复添加', async () => {
        const config = makeConfig({
            auto: autoConfig(),
            backends: [simpleBackend()]
        })
        const { http } = stubHttp({
            '/voice/speakers': {
                data: { VITS: [{ id: 0, name: '测试', lang: ['zh'] }] }
            }
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const status = await pipeline.status()

        expect(status).toHaveLength(1)
        expect(status[0].label).toBe('test')
    })

    it('auto 关闭时不发探测请求', async () => {
        const config = makeConfig({
            auto: autoConfig({ enabled: false }),
            backends: [simpleBackend()]
        })
        const { http, calls } = stubHttp({
            '/voice/speakers': {
                data: { VITS: [{ id: 0, name: 'a', lang: ['zh'] }] }
            }
        })
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        await pipeline.status()

        expect(calls.some((call) => call.url.includes('openapi'))).toBe(false)
    })

    it('自动探测失败会标记未拉全，后端恢复后能补上', async () => {
        const state = { online: false, t: 0 }
        const config = makeConfig({
            auto: autoConfig({ url: 'http://127.0.0.1:23456' }),
            backends: []
        })

        const http: HttpClient = {
            async get(url: string) {
                if (url.endsWith('/voice/speakers')) {
                    if (state.online) {
                        return {
                            VITS: [{ id: 0, name: '银狼', lang: ['zh'] }]
                        }
                    }
                }
                const error = new Error('refused') as Error & {
                    status: number
                }
                error.status = 404
                throw error
            },
            async post() {
                throw new Error('not expected')
            }
        }

        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends,
            now: () => state.t
        })

        expect(await pipeline.ensureVoices()).toHaveLength(0)
        expect(pipeline.needsRefresh()).toBe(true)

        state.online = true
        state.t += 11000

        const voices = await pipeline.ensureVoices(true)

        expect(voices).toHaveLength(1)
        expect(voices[0].key).toBe('自动/银狼_ZH')
        expect(pipeline.needsRefresh()).toBe(false)
    })
})
