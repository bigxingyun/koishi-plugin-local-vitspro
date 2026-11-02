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

export abstract class VitsAdapter {
    abstract readonly type: Backend['type']

    constructor(protected readonly ctx: AdapterContext) {}

    abstract synthesize(request: SynthesizeRequest): Promise<AudioResult>

    /** 自动拉取讲者（默认返回配置里写死的） */
    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        return backend.speakers ?? []
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
