import {
    AudioResult,
    Backend,
    GptSovits2Backend,
    GptSovits2Params,
    SpeakerBase
} from '../types'
import {
    AdapterContext,
    SynthesizeRequest,
    VitsAdapter,
    assertAudio,
    mapLanguage,
    mimeFromFormat,
    toBuffer,
    wrapError
} from './base'
import { BackendError } from '../core/errors'

type GptSpeaker = SpeakerBase & {
    gpt_weights?: string
    sovits_weights?: string
    ref_audio_path?: string
    aux_ref_audio_paths?: string[]
    prompt_text?: string
    prompt_lang?: string
    text_lang?: string
    media_type?: string
    speed?: number
    speed_factor?: number
}

/** v2 的官方默认值（与 api_v2.py 的默认参数保持一致） */
const V2_DEFAULTS: GptSovits2Params = {
    text_split_method: 'cut5',
    batch_size: 1,
    batch_threshold: 0.75,
    split_bucket: true,
    speed_factor: 1,
    fragment_interval: 0.3,
    top_k: 15,
    top_p: 1,
    temperature: 1,
    seed: -1,
    media_type: 'wav',
    streaming_mode: false,
    parallel_infer: true,
    use_cuda_graph: true,
    repetition_penalty: 1.35,
    super_sampling: false
}

/** 允许讲者覆盖的 v2 参数 */
const V2_SPEAKER_KEYS: (keyof GptSpeaker | keyof GptSovits2Params)[] = [
    'top_k',
    'top_p',
    'temperature',
    'text_split_method',
    'batch_size',
    'batch_threshold',
    'split_bucket',
    'speed_factor',
    'fragment_interval',
    'seed',
    'media_type',
    'parallel_infer',
    'use_cuda_graph',
    'repetition_penalty',
    'sample_steps',
    'cfg_rate',
    'super_sampling',
    'streaming_mode',
    'overlap_length',
    'min_chunk_length',
    'gpt_streaming',
    'streaming_chunk_seconds',
    'streaming_window_mode'
]

const WEIGHT_KEYS = [
    'name',
    'gpt_weights',
    'sovits_weights',
    'languages',
    'ref_audio_path',
    'aux_ref_audio_paths',
    'prompt_text',
    'prompt_lang',
    'text_lang',
    'speed'
]

export class GptSovits2Adapter extends VitsAdapter {
    readonly type = 'GPT-SoVITS2' as const

    /** 已切换的底模，避免每次合成都重复调用 set_*_weights */
    private readonly weights = new Map<
        string,
        { gpt?: string; sovits?: string }
    >()

    constructor(ctx: AdapterContext) {
        super(ctx)
    }

    async synthesize(request: SynthesizeRequest): Promise<AudioResult> {
        const backend = request.backend as GptSovits2Backend
        const speaker = request.speaker as GptSpeaker
        const version = backend.apiVersion ?? backend.config?.apiVersion ?? 'v2'

        if (version === 'v1') {
            const payload = this.buildV1Payload(backend, speaker, request)
            this.assertRequired(
                payload,
                ['text', 'text_language', 'refer_wav_path', 'prompt_language'],
                'v1'
            )
            const data = await this.request(backend, '/', payload, request.timeout)
            return { data: assertAudio(data), mime: 'audio/wav' }
        }

        if (speaker.sovits_weights) {
            await this.setWeights(backend, 'sovits', speaker.sovits_weights, request.timeout)
        }
        if (speaker.gpt_weights) {
            await this.setWeights(backend, 'gpt', speaker.gpt_weights, request.timeout)
        }

        const payload = this.buildV2Payload(backend, speaker, request)
        this.assertRequired(
            payload,
            ['text', 'text_lang', 'ref_audio_path', 'prompt_lang'],
            'v2'
        )

        const data = await this.request(backend, '/tts', payload, request.timeout)
        return {
            data: assertAudio(data),
            mime: mimeFromFormat(String(payload.media_type ?? 'wav'))
        }
    }

    // -----------------------------------------------------------------------
    // 请求
    // -----------------------------------------------------------------------

    private async request(
        backend: GptSovits2Backend,
        path: string,
        payload: Record<string, unknown>,
        timeout: number
    ): Promise<Buffer> {
        const method = backend.method ?? backend.config?.method ?? 'auto'
        // 允许直接填完整端点：…/tts 或 …/
        const base = String(backend.url ?? '')
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/tts$/i, '')
        const url = `${base}${path}`

        const headers = this.headers(backend)
        const jsonHeaders = this.headers(backend, {
            'Content-Type': 'application/json'
        })

        const send = async (verb: 'POST' | 'GET'): Promise<unknown> => {
            if (verb === 'POST') {
                return this.ctx.http.post(url, payload, {
                    headers: jsonHeaders,
                    responseType: 'arraybuffer',
                    timeout
                })
            }
            return this.ctx.http.get(`${url}${buildQuery(payload)}`, {
                headers,
                responseType: 'arraybuffer',
                timeout
            })
        }

        try {
            return toBuffer(await send(method === 'get' ? 'GET' : 'POST'))
        } catch (error) {
            if (method !== 'auto' || !shouldFallback(error)) {
                throw this.decorate(error)
            }

            // 老版本 api_v2 可能只有 GET；反过来也有的部署只放 POST
            try {
                return toBuffer(await send('GET'))
            } catch (fallbackError) {
                throw this.decorate(fallbackError)
            }
        }
    }

    private decorate(error: unknown): BackendError {
        const wrapped = wrapError(error, 'GPT-SoVITS')
        const body = extractErrorBody((error as any)?.response?.data)

        if (body && !wrapped.message.includes(body)) {
            return new BackendError(
                wrapped.errorClass,
                `${wrapped.message} · body: ${body}`,
                wrapped.status,
                { cause: error }
            )
        }
        return wrapped
    }

    private assertRequired(
        payload: Record<string, unknown>,
        keys: string[],
        version: 'v1' | 'v2'
    ): void {
        const missing = keys.filter(
            (key) => payload[key] == null || payload[key] === ''
        )
        if (missing.length === 0) return

        throw new BackendError(
            'BAD_REQUEST',
            `GPT-SoVITS ${version} 缺少必填字段：${missing.join(', ')}` +
                '（讲者里需要配置 ref_audio_path 与 prompt_lang；v2 还需要 text_lang）'
        )
    }

    // -----------------------------------------------------------------------
    // 请求体
    // -----------------------------------------------------------------------

    private buildV2Payload(
        backend: GptSovits2Backend,
        speaker: GptSpeaker,
        request: SynthesizeRequest
    ): Record<string, unknown> {
        const merged: Record<string, unknown> = {
            ...V2_DEFAULTS,
            ...(backend.config ?? {})
        }

        for (const key of V2_SPEAKER_KEYS) {
            const value = (speaker as Record<string, unknown>)[key as string]
            if (value != null) merged[key as string] = value
        }

        // 讲者上的 speed 是旧写法，统一成 speed_factor
        if (speaker.speed != null && speaker.speed_factor == null) {
            merged.speed_factor = speaker.speed
        }

        const payload: Record<string, unknown> = {
            ...merged,
            text: request.text,
            text_lang: mapLanguage(
                speaker.text_lang ??
                    request.language ??
                    speaker.languages?.[0] ??
                    'zh'
            ),
            ref_audio_path: speaker.ref_audio_path,
            aux_ref_audio_paths: speaker.aux_ref_audio_paths ?? [],
            prompt_text: speaker.prompt_text ?? '',
            prompt_lang: mapLanguage(
                speaker.prompt_lang ?? request.language ?? 'zh'
            )
        }

        return dropUndefined(payload)
    }

    private buildV1Payload(
        backend: GptSovits2Backend,
        speaker: GptSpeaker,
        request: SynthesizeRequest
    ): Record<string, unknown> {
        const config = backend.config ?? {}
        const payload: Record<string, unknown> = {
            refer_wav_path: speaker.ref_audio_path,
            prompt_text: speaker.prompt_text ?? '',
            prompt_language: mapLanguage(
                speaker.prompt_lang ?? request.language ?? 'zh'
            ),
            text: request.text,
            text_language: mapLanguage(
                speaker.text_lang ??
                    request.language ??
                    speaker.languages?.[0] ??
                    'zh'
            ),
            cut_punc: config.cut_punc,
            top_k: speaker.top_k ?? config.top_k ?? 15,
            top_p: speaker.top_p ?? config.top_p ?? 1,
            temperature: speaker.temperature ?? config.temperature ?? 1,
            speed: speaker.speed ?? config.speed ?? 1,
            inp_refs: speaker.aux_ref_audio_paths ?? [],
            sample_steps: config.sample_steps,
            if_sr: config.if_sr,
            cfg_rate: config.cfg_rate
        }

        return dropUndefined(payload)
    }

    // -----------------------------------------------------------------------
    // 底模切换（仅 v2）
    // -----------------------------------------------------------------------

    private async setWeights(
        backend: GptSovits2Backend,
        which: 'gpt' | 'sovits',
        weightsPath: string,
        timeout: number
    ): Promise<void> {
        const stateKey = backend.label ?? backend.url
        const state = this.weights.get(stateKey) ?? {}
        if (state[which] === weightsPath) return

        const url = `${this.url(backend.url, `/set_${which}_weights`)}?weights_path=${encodeURIComponent(weightsPath)}`

        try {
            const response = await this.ctx.http.get(url, {
                headers: this.headers(backend),
                timeout: Math.max(timeout, 30000)
            })

            if (
                response &&
                typeof response === 'object' &&
                'message' in (response as Record<string, unknown>) &&
                (response as Record<string, unknown>).message !== 'success'
            ) {
                throw new BackendError(
                    'SERVER',
                    `GPT-SoVITS 切换 ${which} 底模失败：${JSON.stringify(response).slice(0, 120)}`
                )
            }

            state[which] = weightsPath
            this.weights.set(stateKey, state)
        } catch (error) {
            throw wrapError(error, `GPT-SoVITS:set_${which}_weights`)
        }
    }
}

function dropUndefined(
    payload: Record<string, unknown>
): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue
        result[key] = value
    }
    return result
}

/** GET 方式：数组用重复 key，布尔转 true/false，跳过空值 */
export function buildQuery(payload: Record<string, unknown>): string {
    const parts: string[] = []

    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null || value === '') continue

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item == null || item === '') continue
                parts.push(
                    `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`
                )
            }
            continue
        }

        parts.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
        )
    }

    return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/** 只有「方法/路径不对」才值得换一种 HTTP 方法再试 */
export function shouldFallback(error: unknown): boolean {
    const status =
        (error as any)?.status ?? (error as any)?.response?.status
    if (status === 405 || status === 404 || status === 501) return true

    const message = String((error as any)?.message ?? '')
    return /method not allowed|405/i.test(message)
}

/** v2 的失败响应是 HTTP 400 + JSON：{"message": "...", "Exception": "..."} */
export function extractErrorBody(raw: unknown): string | undefined {
    if (raw == null) return undefined

    if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer)) {
        try {
            const json = raw as Record<string, unknown>
            const parts = [json.message, json.Exception, json.detail]
                .filter((item) => typeof item === 'string' && item.length > 0)
                .join(' · ')
            if (parts) return parts.slice(0, 300)
            return JSON.stringify(raw).slice(0, 300)
        } catch {
            return undefined
        }
    }

    let text: string | undefined
    if (typeof raw === 'string') text = raw
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8')

    if (!text) return undefined

    try {
        const json = JSON.parse(text)
        const parts = [json.message, json.Exception, json.detail]
            .filter((item: unknown) => typeof item === 'string')
            .join(' · ')
        return (parts || text).slice(0, 300)
    } catch {
        return text.slice(0, 300)
    }
}

