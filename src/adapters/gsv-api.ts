import {
    AudioResult,
    Backend,
    GsvApiBackend,
    GsvApiSpeaker,
    SpeakerBase
} from '../types'
import {
    AdapterContext,
    SynthesizeRequest,
    SpeakerProbe,
    VitsAdapter,
    assertAudio,
    mimeFromFormat,
    mapLanguage,
    toBuffer,
    wrapError
} from './base'
import { BackendError } from '../core/errors'

/** `/v1/speakers` 的字段名是下划线风格 */
interface GsvSpeakerPayload {
    id?: string
    name?: string
    enabled?: boolean
    emotions?: string[]
    default_emotion?: string
    languages?: string[]
    status?: string
}

/**
 * GSV 工作台自带的 v1 公开 API。
 *
 * 和 api_v2 的区别：模型、参考音频、采样参数全部由服务端工作台管理，
 * 调用方只传 text / speaker / emotion / language / format。
 */
export class GsvApiAdapter extends VitsAdapter {
    readonly type = 'gsv-api' as const
    readonly autoPull = true

    constructor(ctx: AdapterContext) {
        super(ctx)
    }

    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        const config = backend as GsvApiBackend
        const url = this.url(config.url, '/v1/speakers')

        try {
            const data = await this.ctx.http.get(url, {
                headers: this.headers(config, this.auth(config)),
                timeout: config.timeout ?? 10000
            })
            return parseSpeakers(data)
        } catch (error) {
            throw wrapError(error, 'gsv-api')
        }
    }

    async synthesize(request: SynthesizeRequest): Promise<AudioResult> {
        const backend = request.backend as GsvApiBackend
        const speaker = request.speaker as GsvApiSpeaker
        // 文档明确：speaker 必须是角色 id，显示名会 404。
        const speakerId = String(speaker.id ?? '').trim()

        if (!speakerId) {
            throw new BackendError('BAD_REQUEST', 'GSV 讲者缺少 id')
        }

        const format = backend.format === 'ogg' ? 'ogg' : 'wav'
        const body: Record<string, unknown> = {
            text: request.text,
            speaker: speakerId,
            format
        }

        // 讲者级情绪优先；没有就用服务端默认情绪
        const emotion = (speaker as Record<string, unknown>).emotion
        if (typeof emotion === 'string' && emotion.trim()) {
            body.emotion = emotion.trim()
        }

        const language = resolveLanguage(backend, request.language)
        if (language) body.language = language

        try {
            const data = await this.ctx.http.post(
                this.url(backend.url, '/v1/audio/speech'),
                body,
                {
                    headers: this.headers(backend, {
                        'Content-Type': 'application/json',
                        ...this.auth(backend)
                    }),
                    responseType: 'arraybuffer',
                    timeout: request.timeout
                }
            )

            return {
                data: assertAudio(toBuffer(data)),
                mime: mimeFromFormat(format)
            }
        } catch (error) {
            throw wrapError(error, 'gsv-api')
        }
    }

    async probeSpeakers(backend: Backend): Promise<SpeakerProbe> {
        const label = backend.label ?? backend.type
        const started = Date.now()
        const config = backend as GsvApiBackend
        const url = this.url(config.url, '/v1/speakers')

        try {
            const speakers = await this.getSpeakers(backend)
            return {
                label,
                type: this.type,
                requested: true,
                url,
                ok: true,
                ms: Date.now() - started,
                count: speakers.length,
                sample: speakers.slice(0, 5).map((item) => item.name),
                hint:
                    speakers.length === 0
                        ? '服务端没有启用的角色，或 /v1/speakers 返回空列表'
                        : undefined
            }
        } catch (error) {
            return {
                label,
                type: this.type,
                requested: true,
                url,
                ok: false,
                ms: Date.now() - started,
                count: 0,
                error: (error as Error)?.message ?? String(error),
                hint: '检查 url 是否指向 9880（公开 API），不是 9881（工作台）'
            }
        }
    }

    private auth(backend: GsvApiBackend): Record<string, string> {
        const key = backend.apiKey?.trim()
        if (!key) return {}

        switch (backend.authMode) {
            case 'x-api-key':
                return { 'X-API-Key': key }
            case 'both':
                return {
                    Authorization: `Bearer ${key}`,
                    'X-API-Key': key
                }
            default:
                return { Authorization: `Bearer ${key}` }
        }
    }
}

export function parseSpeakers(data: unknown): GsvApiSpeaker[] {
    const payload = data as { data?: unknown } | unknown[]

    const list = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: unknown[] }).data)
          : []

    return list
        .map((item) => item as GsvSpeakerPayload)
        .filter((item) => item && typeof item === 'object')
        .filter((item) => item.enabled !== false && item.status !== 'disabled')
        .map((item) => {
            const speaker: GsvApiSpeaker = {
                name: String(item.name ?? item.id ?? 'unknown'),
                languages: Array.isArray(item.languages) ? item.languages : []
            }

            if (item.id != null) speaker.id = String(item.id)
            if (Array.isArray(item.emotions)) speaker.emotions = item.emotions
            if (item.default_emotion) {
                speaker.defaultEmotion = String(item.default_emotion)
            }
            if (item.status) speaker.status = String(item.status)

            return speaker
        })
}

function resolveLanguage(
    backend: GsvApiBackend,
    requested?: string
): string | undefined {
    const explicit = String(backend.language ?? '').trim()
    if (explicit) return explicit

    const language = String(requested ?? '').trim()
    if (!language) return undefined

    const mapped = mapLanguage(language)
    return mapped === 'zh' && !/zh|cmn|chinese/i.test(language)
        ? language.toLowerCase()
        : mapped
}

