import { describe, expect, it } from 'vitest'
import { VitsSimpleApiAdapter } from '../src/adapters/vits-simple-api'
import { GptSovits2Adapter } from '../src/adapters/gpt-sovits2'
import { FishAudioAdapter } from '../src/adapters/fish-audio'
import { QQVoiceAdapter } from '../src/adapters/qq-voice'
import { createStubHttp, silentLogger, simpleBackend, wav } from './helpers'

const logger = silentLogger

describe('VitsSimpleApiAdapter', () => {
    it('VITS：form-data 字段与鉴权头格式正确', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        await adapter.synthesize({
            text: '你好世界',
            backend: simpleBackend({
                apiKey: 'secret-key',
                username: 'user',
                password: 'pass'
            } as any),
            speaker: { name: '测试', id: 3, type: 'VITS', languages: ['ZH'] },
            language: 'ZH',
            timeout: 5000
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/vits')

        const form = calls[0].body as FormData
        expect(form.get('text')).toBe('你好世界')
        expect(form.get('id')).toBe('3')
        expect(form.get('lang')).toBe('zh')

        const headers = calls[0].config.headers as Record<string, string>
        expect(headers['X-API-KEY']).toBe('secret-key')
        expect(headers['Authorization']).toBe(
            'Basic ' + Buffer.from('user:pass').toString('base64')
        )
    })

    it('GPT-SOVITS 讲者走 /voice/gpt-sovits 且 prompt_lang 归一化', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        await adapter.synthesize({
            text: '测试',
            backend: simpleBackend(),
            speaker: {
                name: '花火',
                id: 0,
                type: 'GPT-SOVITS',
                languages: ['ZH', 'JA'],
                prompt_text: '参考文本',
                prompt_lang: 'JP',
                preset: 'default'
            },
            language: 'JA',
            timeout: 5000
        })

        expect(calls[0].url).toBe('http://127.0.0.1:23456/voice/gpt-sovits')

        const form = calls[0].body as FormData
        expect(form.get('text')).toBe('测试')
        expect(form.get('lang')).toBe('ja')
        expect(form.get('prompt_lang')).toBe('ja')
        expect(form.get('prompt_text')).toBe('参考文本')
        expect(form.get('preset')).toBe('default')
    })

    it('自动拉取讲者：解析 /voice/speakers', async () => {
        const { http } = createStubHttp((call) =>
            call.url.endsWith('/voice/speakers')
                ? {
                      VITS: [{ name: '派蒙', id: 0, lang: ['zh'] }],
                      'HUBERT-VITS': [{ name: '忽略', id: 1 }]
                  }
                : wav()
        )
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        const speakers = await adapter.getSpeakers({
            ...(simpleBackend() as any),
            speakers: [],
            autoPullSpeaker: true
        })

        expect(speakers).toEqual([
            {
                name: '派蒙',
                id: 0,
                lang: ['zh'],
                languages: ['ZH'],
                type: 'VITS'
            }
        ])
    })

    it('后端未启动时 getSpeakers 抛错（交给 Pipeline 重试，不要静默吞掉）', async () => {
        const { http } = createStubHttp(() => {
            const error = new Error('connect refused') as Error & {
                code: string
            }
            error.code = 'ECONNREFUSED'
            throw error
        })
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        await expect(
            adapter.getSpeakers({
                ...(simpleBackend() as any),
                speakers: [],
                autoPullSpeaker: true
            })
        ).rejects.toThrow('connect refused')
    })

    it('autoPullSpeaker=false 时完全不请求', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new VitsSimpleApiAdapter({ http, logger })

        const speakers = await adapter.getSpeakers({
            ...(simpleBackend() as any),
            autoPullSpeaker: false
        })

        expect(calls).toHaveLength(0)
        expect(speakers).toHaveLength(1)
    })
})

describe('GptSovits2Adapter', () => {
    it('先切底模再 POST /tts，JSON 字段正确', async () => {
        const { http, calls } = createStubHttp((call) =>
            call.method === 'GET' ? { message: 'success' } : wav(0.3)
        )
        const adapter = new GptSovits2Adapter({ http, logger })

        const result = await adapter.synthesize({
            text: '今日はいい天気ですね',
            backend: {
                type: 'GPT-SoVITS2',
                label: '银狼',
                url: 'http://127.0.0.1:9880',
                config: { text_split_method: 'cut5', batch_size: 1 }
            } as any,
            speaker: {
                name: '丛雨',
                gpt_weights: 'GPT_SoVITS/pretrained/x.ckpt',
                sovits_weights: 'SoVITS_weights_v2/y.pth',
                ref_audio_path: 'audio/ref.ogg',
                prompt_text: 'ほれ',
                prompt_lang: 'JP',
                speed: 1.1,
                media_type: 'wav'
            },
            language: 'JA',
            timeout: 5000
        })

        expect(result.mime).toBe('audio/wav')
        expect(calls.map((call) => call.method)).toEqual([
            'GET',
            'GET',
            'POST'
        ])

        // 权重切换的 URL 里路径要编码
        expect(calls[0].url).toContain('/set_sovits_weights?weights_path=')
        expect(calls[0].url).toContain(
            encodeURIComponent('SoVITS_weights_v2/y.pth')
        )
        expect(calls[1].url).toContain('/set_gpt_weights?weights_path=')

        expect(calls[2].url).toBe('http://127.0.0.1:9880/tts')

        const payload = calls[2].body as Record<string, unknown>
        expect(payload.text).toBe('今日はいい天気ですね')
        expect(payload.text_lang).toBe('ja')
        expect(payload.prompt_lang).toBe('ja')
        expect(payload.ref_audio_path).toBe('audio/ref.ogg')
        expect(payload.text_split_method).toBe('cut5')
        expect(payload.batch_size).toBe(1)
        expect(payload.streaming_mode).toBe(false)
        expect(payload.speed_factor).toBe(1.1)
        expect(payload.speed).toBeUndefined()
        expect(payload.name).toBeUndefined()
        expect(payload.gpt_weights).toBeUndefined()
        expect(payload.sovits_weights).toBeUndefined()
    })

    it('同一底模不重复切换', async () => {
        const { http, calls } = createStubHttp((call) =>
            call.method === 'GET' ? { message: 'success' } : wav(0.2)
        )
        const adapter = new GptSovits2Adapter({ http, logger })
        const backend = {
            type: 'GPT-SoVITS2',
            label: '银狼',
            url: 'http://127.0.0.1:9880'
        } as any
        const speaker = {
            name: '丛雨',
            sovits_weights: 'a.pth',
            gpt_weights: 'b.ckpt'
        }

        await adapter.synthesize({
            text: '一',
            backend,
            speaker,
            timeout: 5000
        })
        await adapter.synthesize({
            text: '二',
            backend,
            speaker,
            timeout: 5000
        })

        expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2)
        expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
    })
})

describe('FishAudioAdapter', () => {
    it('Bearer 鉴权与 JSON 字段正确', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new FishAudioAdapter({ http, logger })

        await adapter.synthesize({
            text: '你好',
            backend: {
                type: 'fish-audio',
                label: 'fish',
                apiKey: 'fish-key'
            } as any,
            speaker: {
                name: '丁真',
                reference_id: 'ref-123',
                format: 'mp3',
                chunk_length: 200
            },
            timeout: 5000
        })

        expect(calls[0].url).toBe('https://api.fish.audio/v1/tts')

        const headers = calls[0].config.headers as Record<string, string>
        expect(headers['Authorization']).toBe('Bearer fish-key')

        const payload = calls[0].body as Record<string, unknown>
        expect(payload.text).toBe('你好')
        expect(payload.reference_id).toBe('ref-123')
        expect(payload.format).toBe('mp3')
        expect(payload.chunk_length).toBe(200)
        expect(payload.normalize).toBe(true)
        expect(payload.latency).toBe('normal')
        expect(payload.name).toBeUndefined()
        expect(payload.languages).toBeUndefined()
    })
})

describe('QQVoiceAdapter', () => {
    it('调用 OneBot 的 send_group_ai_record 并标记已发送', async () => {
        const { http } = createStubHttp()
        const adapter = new QQVoiceAdapter({ http, logger })
        const requests: { action: string; params: any }[] = []

        const session = {
            platform: 'onebot',
            isDirect: false,
            guildId: '123456',
            onebot: {
                _request: async (action: string, params: any) => {
                    requests.push({ action, params })
                    return { data: 'ok' }
                }
            }
        }

        const result = await adapter.synthesize({
            text: '你好',
            backend: { type: 'qq-voice', label: 'qq' } as any,
            speaker: { name: '派蒙', characterId: 'char-1' },
            timeout: 5000,
            session
        })

        expect(result.sent).toBe(true)
        expect(requests).toEqual([
            {
                action: 'send_group_ai_record',
                params: {
                    group_id: '123456',
                    character: 'char-1',
                    text: '你好'
                }
            }
        ])
    })

    it('私聊直接报参数错误', async () => {
        const { http } = createStubHttp()
        const adapter = new QQVoiceAdapter({ http, logger })

        await expect(
            adapter.synthesize({
                text: '你好',
                backend: { type: 'qq-voice' } as any,
                speaker: { name: '派蒙', characterId: 'c' },
                timeout: 5000,
                session: { platform: 'onebot', isDirect: true, onebot: {} }
            })
        ).rejects.toMatchObject({ errorClass: 'BAD_REQUEST' })
    })
})
