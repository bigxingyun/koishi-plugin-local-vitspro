import {
    AudioResult,
    Backend,
    HttpClient,
    LoggerLike,
    SpeakerBase
} from '../types'
import { BackendError, classifyError } from '../core/errors'

export interface AdapterContext {
    http: HttpClient
    logger: LoggerLike
}

export interface SynthesizeRequest {
    text: string
    backend: Backend
    speaker: SpeakerBase
    /** 语言（大写，如 ZH），可能没有 */
    language?: string
    /** 本次请求超时（毫秒） */
    timeout: number
    /** 需要 session 的后端（QQ 声聊） */
    session?: any
}

/** `tts probe` 的输出：只做一次真实的讲者探测，不触发合成 */
export interface SpeakerProbe {
    label: string
    type: Backend['type']
    /** 该后端是否真的发了请求（autoPullSpeaker=false 时为 false） */
    requested: boolean
    url?: string
    ok: boolean
    status?: number
    ms: number
    count: number
    sample?: string[]
    error?: string
    /** 针对常见配置错误的提示 */
    hint?: string
}

export abstract class VitsAdapter {
    abstract readonly type: Backend['type']

    /** 该后端是否支持从远端自动拉取讲者（用于判断「没拉到」是不是异常） */
    readonly autoPull: boolean = false

    constructor(protected readonly ctx: AdapterContext) {}

    abstract synthesize(request: SynthesizeRequest): Promise<AudioResult>

    /** 自动拉取讲者（默认返回配置里写死的） */
    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        return backend.speakers ?? []
    }

    /** 诊断：跑一次讲者拉取，把 URL / 状态 / 耗时 / 错误都带回来 */
    async probeSpeakers(backend: Backend): Promise<SpeakerProbe> {
        const started = Date.now()
        const label = backend.label ?? backend.type

        if (this.autoPull && backend.autoPullSpeaker === false) {
            return {
                label,
                type: backend.type,
                requested: false,
                ok: false,
                ms: 0,
                count: 0,
                hint: 'autoPullSpeaker=false，不会请求后端；请手动配置 speakers'
            }
        }

        try {
            const speakers = await this.getSpeakers(backend)
            return {
                label,
                type: backend.type,
                requested: this.autoPull,
                ok: true,
                ms: Date.now() - started,
                count: speakers.length,
                sample: speakers.slice(0, 5).map((speaker) => speaker.name),
                hint:
                    this.autoPull && speakers.length === 0
                        ? '后端返回了空的讲者列表：确认后端已加载模型（/voice/speakers 里有内容）'
                        : undefined
            }
        } catch (error) {
            return {
                label,
                type: backend.type,
                requested: true,
                ok: false,
                ms: Date.now() - started,
                count: 0,
                error: (error as Error)?.message ?? String(error)
            }
        }
    }

    protected headers(
        backend: Backend,
        extra?: Record<string, string>
    ): Record<string, string> {
        return { ...(backend.headers ?? {}), ...(extra ?? {}) }
    }

    protected url(base: string, path: string): string {
        return `${base.replace(/\/+$/, '')}${path}`
    }
}

export function toBuffer(data: unknown): Buffer {
    if (Buffer.isBuffer(data)) return data
    if (data instanceof ArrayBuffer) return Buffer.from(data)
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    if (typeof data === 'string') return Buffer.from(data)
    if (data && typeof data === 'object' && 'data' in (data as any)) {
        return toBuffer((data as any).data)
    }
    throw new BackendError('EMPTY', '后端返回了无法识别的音频数据')
}

export function mimeFromFormat(format?: string): string {
    const value = String(format ?? 'wav').toLowerCase().replace(/^\./, '')
    switch (value) {
        case 'mp3':
            return 'audio/mpeg'
        case 'flac':
            return 'audio/flac'
        case 'ogg':
        case 'opus':
            return 'audio/ogg'
        case 'pcm':
            return 'audio/pcm'
        default:
            return 'audio/wav'
    }
}

export function shortFormat(mime: string): string {
    if (/mpeg|mp3/i.test(mime)) return 'mp3'
    if (/flac/i.test(mime)) return 'flac'
    if (/ogg|opus/i.test(mime)) return 'ogg'
    if (/pcm/i.test(mime)) return 'pcm'
    return 'wav'
}

/** 把各种写法的语言名归一成 GPT-SoVITS / vits-simple-api 认识的短码 */
export function mapLanguage(language?: string): string {
    const value = String(language ?? '').toLowerCase().replace(/_/g, '-')
    switch (value) {
        case 'zh':
        case 'zh-cn':
        case 'cmn':
        case 'chinese':
            return 'zh'
        case 'en':
        case 'en-us':
        case 'english':
            return 'en'
        case 'jp':
        case 'ja':
        case 'japanese':
            return 'ja'
        case 'kr':
        case 'ko':
        case 'korean':
            return 'ko'
        case 'yue':
        case 'cantonese':
            return 'yue'
        default:
            return value || 'zh'
    }
}

/** 统一校验空音频：200 但 0 字节要当成 EMPTY 而不是成功 */
export function assertAudio(data: Buffer): Buffer {
    if (!data || data.length === 0) {
        throw new BackendError('EMPTY', '后端返回了空音频')
    }
    return data
}

/** 把 http 层的异常转成带语义分类的 BackendError */
export function wrapError(error: unknown, label: string): BackendError {
    if (error instanceof BackendError) return error

    const err = error as any
    const status: number | undefined =
        err?.status ?? err?.response?.status ?? undefined
    const errorClass = classifyError(error)
    const detail =
        err?.response?.data && typeof err.response.data === 'string'
            ? err.response.data.slice(0, 120)
            : ''
    const message = `[${label}] ${errorClass}${status ? ` ${status}` : ''}${
        detail ? `: ${detail}` : ''
    }${err?.message ? ` (${String(err.message).slice(0, 120)})` : ''}`

    return new BackendError(errorClass, message, status, { cause: error })
}
