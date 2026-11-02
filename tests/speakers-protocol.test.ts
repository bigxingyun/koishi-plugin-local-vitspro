import { describe, expect, it } from 'vitest'
import {
    VitsSimpleApiAdapter,
    parseSpeakersResponse,
    speakersErrorHint
} from '../src/adapters/vits-simple-api'
import { Pipeline } from '../src/core/pipeline'
import { createStubHttp, makeConfig, silentLogger, simpleBackend, wav } from './helpers'

const logger = silentLogger

describe('parseSpeakersResponse', () => {
    it('标准形状：按模型类型分组、lang 数组', () => {
        const speakers = parseSpeakersResponse({
            VITS: [{ id: 0, name: '派蒙', lang: ['zh'] }],
            'BERT-VITS2': [{ id: 1, name: '花火', lang: ['zh', 'ja'] }]
        })

        expect(speakers).toEqual([
            { id: 0, name: '派蒙', lang: ['zh'], languages: ['ZH'], type: 'VITS' },
            {
                id: 1,
                name: '花火',
                lang: ['zh', 'ja'],
                languages: ['ZH', 'JA'],
                type: 'BERT-VITS2'
            }
        ])
    })

    it('跳过 HUBERT-VITS', () => {
        const speakers = parseSpeakersResponse({
            VITS: [{ id: 0, name: 'a', lang: ['zh'] }],
            'HUBERT-VITS': [{ id: 1, name: 'b', lang: ['zh'] }]
        })

        expect(speakers.map((item) => item.name)).toEqual(['a'])
    })

    it('兼容 lang 为字符串', () => {
        const speakers = parseSpeakersResponse({
            'GPT-SOVITS': [{ id: 3, name: 'c', lang: 'zh' }]
        })

        expect(speakers[0].languages).toEqual(['ZH'])
    })

    it('兼容数组根节点', () => {
        const speakers = parseSpeakersResponse([{ id: 0, name: 'a', lang: ['zh'] }])

        expect(speakers).toHaveLength(1)
        expect(speakers[0].name).toBe('a')
    })

    it('兼容 { data: [...] } 与 { speakers: [...] }', () => {
        expect(
            parseSpeakersResponse({ data: [{ name: 'a', lang: ['zh'] }] })
        ).toHaveLength(1)
        expect(
            parseSpeakersResponse({ speakers: [{ name: 'b', lang: ['zh'] }] })
        ).toHaveLength(1)
    })

    it('兼容以 id 为键的对象', () => {
        const speakers = parseSpeakersResponse({
            VITS: { 0: { name: 'a', lang: ['zh'] } }
        })

        expect(speakers).toHaveLength(1)
        expect(speakers[0].name).toBe('a')
    })

    it('无 name 时回退到 id', () => {
        const speakers = parseSpeakersResponse({ VITS: [{ id: 7 }] })

        expect(speakers[0].name).toBe('7')
    })

    it('非法输入返回空数组', () => {
        expect(parseSpeakersResponse(null)).toEqual([])
        expect(parseSpeakersResponse('oops')).toEqual([])
        expect(parseSpeakersResponse({})).toEqual([])
    })
})

describe('speakersErrorHint', () => {
    it('404 提示检查 URL', () => {
        expect(speakersErrorHint(404, 'BAD_REQUEST')).toContain('根地址')
    })

    it('401/403 提示鉴权', () => {
        expect(speakersErrorHint(401, 'AUTH')).toContain('鉴权')
    })

    it('CONNECT 提示连不上', () => {
        expect(speakersErrorHint(undefined, 'CONNECT')).toContain('连不上')
    })
})

describe('speakers URL 归一化', () => {
    function adapterWith(handler?: Parameters<typeof createStubHttp>[0]) {
        const { http, calls } = createStubHttp(handler ?? (() => wav(0.1)))
        return { adapter: new VitsSimpleApiAdapter({ http, logger }), calls }
    }

    it('url 带尾部 /voice 时不会拼成 /voice/voice', async () => {
        const { adapter, calls } = adapterWith((call) =>
            call.url.endsWith('/voice/speakers')
                ? { VITS: [{ id: 0, name: 'a', lang: ['zh'] }] }
                : wav(0.1)
        )

        const speakers = await adapter.getSpeakers({
            ...(simpleBackend() as any),
            url: 'http://127.0.0.1:23456/voice',
            speakers: [],
            autoPullSpeaker: true
        })

        expect(speakers).toHaveLength(1)
        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/speakers')
    })

    it('url 直接填了完整合成端点时也能还原成根地址', async () => {
        const { adapter, calls } = adapterWith((call) =>
            call.url.endsWith('/voice/speakers')
                ? { VITS: [{ id: 0, name: 'a', lang: ['zh'] }] }
                : wav(0.1)
        )

        const speakers = await adapter.getSpeakers({
            ...(simpleBackend() as any),
            url: 'http://127.0.0.1:23456/voice/vits',
            speakers: [],
            autoPullSpeaker: true
        })

        expect(speakers).toHaveLength(1)
        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/speakers')
    })

    it('url 带尾部斜杠时同样归一化', async () => {
        const { adapter, calls } = adapterWith((call) =>
            call.url.endsWith('/voice/speakers') ? { VITS: [] } : wav(0.1)
        )

        await adapter.getSpeakers({
            ...(simpleBackend() as any),
            url: 'http://127.0.0.1:23456/',
            speakers: [],
            autoPullSpeaker: true
        })

        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/speakers')
    })

    it('合成接口也使用归一化后的地址', async () => {
        const { adapter, calls } = adapterWith()

        await adapter.synthesize({
            text: '你好',
            backend: {
                ...(simpleBackend() as any),
                url: 'http://127.0.0.1:23456/voice/'
            },
            speaker: { name: 'a', id: 0, type: 'VITS', languages: ['ZH'] },
            language: 'ZH',
            timeout: 5000
        })

        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/vits')
    })
})

describe('probeSpeakers', () => {
    it('成功时返回 URL / 状态 / 数量 / 示例', async () => {
        const { http } = createStubHttp((call) =>
            call.url.endsWith('/voice/speakers')
                ? {
                      VITS: [
                          { id: 0, name: '派蒙', lang: ['zh'] },
                          { id: 1, name: '花火', lang: ['zh'] }
                      ]
                  }
                : wav(0.1)
        )
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        const probe = await adapter.probeSpeakers({
            ...(simpleBackend() as any),
            speakers: [],
            autoPullSpeaker: true
        })

        expect(probe.ok).toBe(true)
        expect(probe.status).toBe(200)
        expect(probe.count).toBe(2)
        expect(probe.sample).toEqual(['派蒙', '花火'])
        expect(probe.url).toBe('http://127.0.0.1:23456/voice/speakers')
    })

    it('404 时返回提示', async () => {
        const { http } = createStubHttp(() => {
            const error = new Error('not found') as Error & { status: number }
            error.status = 404
            throw error
        })
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        const probe = await adapter.probeSpeakers({
            ...(simpleBackend() as any),
            speakers: [],
            autoPullSpeaker: true
        })

        expect(probe.ok).toBe(false)
        expect(probe.status).toBe(404)
        expect(probe.hint).toContain('根地址')
    })

    it('autoPullSpeaker=false 时不发请求', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        const probe = await adapter.probeSpeakers({
            ...(simpleBackend() as any),
            autoPullSpeaker: false
        })

        expect(probe.requested).toBe(false)
        expect(probe.count).toBe(1)
        expect(calls).toHaveLength(0)
    })
})

describe('Pipeline.probe', () => {
    it('对每个启用后端各探测一次', async () => {
        const config = makeConfig({
            backends: [
                {
                    ...(simpleBackend({ label: 'a' } as any) as any),
                    speakers: [],
                    autoPullSpeaker: true
                }
            ]
        })
        const { http } = createStubHttp((call) =>
            call.url.endsWith('/voice/speakers')
                ? { VITS: [{ id: 0, name: '派蒙', lang: ['zh'] }] }
                : wav(0.1)
        )
        const pipeline = new Pipeline({
            http,
            logger,
            config,
            backends: () => config.backends
        })

        const probes = await pipeline.probe()

        expect(probes).toHaveLength(1)
        expect(probes[0].ok).toBe(true)
        expect(probes[0].count).toBe(1)
    })
})
