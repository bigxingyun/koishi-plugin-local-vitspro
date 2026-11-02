import { describe, expect, it } from 'vitest'
import {
    GptSovits2Adapter,
    buildQuery,
    extractErrorBody,
    shouldFallback
} from '../src/adapters/gpt-sovits2'
import { createStubHttp, silentLogger, wav } from './helpers'

const logger = silentLogger

function backend(patch: Record<string, unknown> = {}) {
    return {
        type: 'GPT-SoVITS2',
        label: 'gsv',
        url: 'http://127.0.0.1:9880',
        ...patch
    } as any
}

const speaker = {
    name: '丛雨',
    ref_audio_path: 'audio/mur001_062.ogg',
    prompt_text: 'ほれ、吾輩の言った通りであろう？',
    prompt_lang: 'jp',
    text_lang: 'zh'
}

const request = (text = '今天天气不错') => ({
    text,
    timeout: 5000
})

describe('GPT-SoVITS v2', () => {
    it('POST /tts 带齐官方参数，且不含未定义字段', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        const result = await adapter.synthesize({
            ...request(),
            backend: backend(),
            speaker
        } as any)

        expect(result.mime).toBe('audio/wav')
        expect(calls).toHaveLength(1)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toBe('http://127.0.0.1:9880/tts')

        const payload = calls[0].body as Record<string, any>
        expect(payload.text).toBe('今天天气不错')
        expect(payload.text_lang).toBe('zh')
        expect(payload.ref_audio_path).toBe('audio/mur001_062.ogg')
        expect(payload.prompt_lang).toBe('ja')
        expect(payload.prompt_text).toBe('ほれ、吾輩の言った通りであろう？')

        // 官方默认值
        expect(payload.top_k).toBe(15)
        expect(payload.top_p).toBe(1)
        expect(payload.temperature).toBe(1)
        expect(payload.text_split_method).toBe('cut5')
        expect(payload.batch_size).toBe(1)
        expect(payload.batch_threshold).toBe(0.75)
        expect(payload.split_bucket).toBe(true)
        expect(payload.speed_factor).toBe(1)
        expect(payload.fragment_interval).toBe(0.3)
        expect(payload.seed).toBe(-1)
        expect(payload.media_type).toBe('wav')
        expect(payload.streaming_mode).toBe(false)
        expect(payload.parallel_infer).toBe(true)
        expect(payload.repetition_penalty).toBe(1.35)
        expect(payload.aux_ref_audio_paths).toEqual([])

        // 没有下发的可选字段不应出现
        expect('sample_steps' in payload).toBe(false)
        expect('cfg_rate' in payload).toBe(false)
        expect('name' in payload).toBe(false)
    })

    it('讲者覆盖后端默认值', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        await adapter.synthesize({
            ...request(),
            backend: backend({ config: { top_k: 5, speed_factor: 1.2 } }),
            speaker: { ...speaker, top_k: 9, sample_steps: 32 }
        } as any)

        const payload = calls[0].body as Record<string, any>
        expect(payload.top_k).toBe(9)
        expect(payload.speed_factor).toBe(1.2)
        expect(payload.sample_steps).toBe(32)
    })

    it('method=get 时用 query string，数组重复 key', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        await adapter.synthesize({
            ...request('你好'),
            backend: backend({ method: 'get' }),
            speaker: { ...speaker, aux_ref_audio_paths: ['a.wav', 'b.wav'] }
        } as any)

        expect(calls[0].method).toBe('GET')
        const url = calls[0].url
        expect(url.startsWith('http://127.0.0.1:9880/tts?')).toBe(true)
        expect(url).toContain(`text=${encodeURIComponent('你好')}`)
        expect(url).toContain('text_lang=zh')
        expect(url).toContain('ref_audio_path=audio%2Fmur001_062.ogg')
        expect(url).toContain('aux_ref_audio_paths=a.wav')
        expect(url).toContain('aux_ref_audio_paths=b.wav')
        expect(url).not.toContain('undefined')
    })

    it('auto：POST 405 时回退 GET', async () => {
        const { http, calls } = createStubHttp((call) => {
            if (call.method === 'POST') {
                const error = new Error('Method Not Allowed') as Error & {
                    status: number
                }
                error.status = 405
                throw error
            }
            return wav(0.1)
        })
        const adapter = new GptSovits2Adapter({ http, logger })

        const result = await adapter.synthesize({
            ...request(),
            backend: backend(),
            speaker
        } as any)

        expect(result.data.length).toBeGreaterThan(44)
        expect(calls.map((call) => call.method)).toEqual(['POST', 'GET'])
    })

    it('缺少 ref_audio_path 时直接报参数错误，不发请求', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        await expect(
            adapter.synthesize({
                ...request(),
                backend: backend(),
                speaker: { name: '无参考', prompt_lang: 'zh' }
            } as any)
        ).rejects.toMatchObject({ errorClass: 'BAD_REQUEST' })

        expect(calls).toHaveLength(0)
    })

    it('后端 400 的 JSON 错误体会被解析进错误信息', async () => {
        const { http } = createStubHttp(() => {
            const error = new Error('Request failed 400') as Error & {
                status: number
                response: { status: number; data: Buffer }
            }
            error.status = 400
            error.response = {
                status: 400,
                data: Buffer.from(
                    JSON.stringify({
                        message: 'ref audio not found',
                        Exception: 'audio/xxx.ogg'
                    })
                )
            }
            throw error
        })
        const adapter = new GptSovits2Adapter({ http, logger })

        await expect(
            adapter.synthesize({
                ...request(),
                backend: backend(),
                speaker
            } as any)
        ).rejects.toThrow(/ref audio not found/)
    })

    it('切换底模失败（message != success）会抛错', async () => {
        const { http } = createStubHttp((call) =>
            call.method === 'GET'
                ? { message: 'weights not found' }
                : wav(0.1)
        )
        const adapter = new GptSovits2Adapter({ http, logger })

        await expect(
            adapter.synthesize({
                ...request(),
                backend: backend(),
                speaker: { ...speaker, sovits_weights: 'missing.pth' }
            } as any)
        ).rejects.toThrow(/切换 sovits 底模失败/)
    })
})

describe('GPT-SoVITS v1（老版 api.py）', () => {
    it('POST / 使用 refer_wav_path / prompt_language / inp_refs', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        await adapter.synthesize({
            ...request('你好'),
            backend: backend({ apiVersion: 'v1', config: { speed: 1.1 } }),
            speaker: { ...speaker, aux_ref_audio_paths: ['a.wav'] }
        } as any)

        expect(calls).toHaveLength(1)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toBe('http://127.0.0.1:9880/')

        const payload = calls[0].body as Record<string, any>
        expect(payload.refer_wav_path).toBe('audio/mur001_062.ogg')
        expect(payload.prompt_language).toBe('ja')
        expect(payload.text_language).toBe('zh')
        expect(payload.text).toBe('你好')
        expect(payload.inp_refs).toEqual(['a.wav'])
        expect(payload.speed).toBe(1.1)
        expect(payload.prompt_lang).toBeUndefined()
        expect(payload.ref_audio_path).toBeUndefined()
    })

    it('v1 不调用 set_*_weights', async () => {
        const { http, calls } = createStubHttp()
        const adapter = new GptSovits2Adapter({ http, logger })

        await adapter.synthesize({
            ...request(),
            backend: backend({ apiVersion: 'v1' }),
            speaker: {
                ...speaker,
                gpt_weights: 'g.ckpt',
                sovits_weights: 's.pth'
            }
        } as any)

        expect(calls).toHaveLength(1)
        expect(calls[0].method).toBe('POST')
    })
})

describe('GPT-SoVITS 辅助函数', () => {
    it('buildQuery 跳过空值、数组重复、布尔可读', () => {
        const query = buildQuery({
            text: 'a b',
            empty: '',
            none: undefined,
            list: ['x', 'y'],
            flag: false
        })

        expect(query).toBe('?text=a%20b&list=x&list=y&flag=false')
    })

    it('shouldFallback 只对 405/404/501 生效', () => {
        expect(shouldFallback({ status: 405 })).toBe(true)
        expect(shouldFallback({ response: { status: 404 } })).toBe(true)
        expect(shouldFallback({ status: 400 })).toBe(false)
        expect(shouldFallback(new Error('boom'))).toBe(false)
    })

    it('extractErrorBody 支持 Buffer / 字符串 / 对象', () => {
        expect(
            extractErrorBody(Buffer.from('{"message":"m","Exception":"e"}'))
        ).toBe('m · e')
        expect(extractErrorBody('{"message":"only"}')).toBe('only')
        expect(extractErrorBody({ message: 'obj', detail: 'd' })).toBe('obj · d')
        expect(extractErrorBody(undefined)).toBeUndefined()
    })
})
