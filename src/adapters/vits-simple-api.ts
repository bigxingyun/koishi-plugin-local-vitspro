import fs from 'node:fs/promises'
import path from 'node:path'
import {
    AudioResult,
    Backend,
    SpeakerBase,
    VitsSimpleApiBackend
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
import { BackendError, classifyError } from '../core/errors'
import { ErrorClass } from '../types'

type SimpleSpeaker = SpeakerBase & {
    id?: number
    type?: 'VITS' | 'W2V2-VITS' | 'BERT-VITS2' | 'GPT-SOVITS'
    languages?: string[]
}

const ENDPOINTS: Record<string, string> = {
    VITS: '/voice/vits',
    'W2V2-VITS': '/voice/w2v2-vits',
    'BERT-VITS2': '/voice/bert-vits2',
    'GPT-SOVITS': '/voice/gpt-sovits'
}

/** 每种讲者类型允许透传的请求参数（其余字段会被忽略） */
const ALLOWED: Record<string, string[]> = {
    VITS: ['length', 'noise', 'noise_w', 'segment_size', 'format'],
    'W2V2-VITS': [
        'length',
        'noise',
        'noise_w',
        'segment_size',
        'emotion',
        'format'
    ],
    'BERT-VITS2': [
        'length',
        'noise',
        'noise_w',
        'segment_size',
        'sdp_ratio',
        'text_prompt',
        'format'
    ],
    'GPT-SOVITS': [
        'segment_size',
        'batch_size',
        'temperature',
        'top_p',
        'speed',
        'top_k',
        'preset',
        'prompt_text',
        'prompt_lang',
        'format'
    ]
}

const MIME_BY_EXT: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg'
}

export class VitsSimpleApiAdapter extends VitsAdapter {
    readonly type = 'vits-simple-api' as const
    readonly autoPull = true

    constructor(ctx: AdapterContext) {
        super(ctx)
    }

    async synthesize(request: SynthesizeRequest): Promise<AudioResult> {
        const backend = request.backend as VitsSimpleApiBackend
        const speaker = request.speaker as SimpleSpeaker
        const type = speaker.type ?? 'VITS'
        const endpoint = ENDPOINTS[type] ?? ENDPOINTS.VITS
        const payload = this.buildPayload(request, speaker, type)
        const url = this.url(backend.url, endpoint)

        const form = new FormData()
        for (const [key, value] of Object.entries(payload)) {
            if (value == null || value === '') continue
            if (key === 'reference_audio') {
                const filePath = String(value)
                let file: Buffer
                try {
                    file = await fs.readFile(filePath)
                } catch (error) {
                    throw new BackendError(
                        'BAD_REQUEST',
                        `参考音频读取失败：${filePath}`,
                        undefined,
                        { cause: error }
                    )
                }
                const mime =
                    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ??
                    'application/octet-stream'
                form.append(
                    'reference_audio',
                    new Blob([new Uint8Array(file)], { type: mime }),
                    path.basename(filePath)
                )
                continue
            }
            form.append(key, String(value))
        }

        const headers = this.buildHeaders(backend)

        try {
            const data = await this.ctx.http.post(url, form, {
                headers,
                responseType: 'arraybuffer',
                timeout: request.timeout
            })

            return {
                data: assertAudio(toBuffer(data)),
                mime: mimeFromFormat(String(payload.format ?? 'wav'))
            }
        } catch (error) {
            throw wrapError(error, 'vits-simple-api')
        }
    }

    /**
     * 基础地址容错：允许用户直接填完整的合成端点。
     * `…/voice/vits`、`…/voice/bert-vits2`、`…/voice`、尾部斜杠都会被还原成根地址。
     */
    protected url(base: string, path: string): string {
        const cleaned = String(base ?? '')
            .trim()
            .replace(/\/+$/, '')
            .replace(
                /\/voice\/(?:vits|w2v2-vits|bert-vits2|gpt-sovits|hubert-vits)$/i,
                ''
            )
            .replace(/\/voice$/i, '')
        return `${cleaned}${path}`
    }

    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        const simple = backend as VitsSimpleApiBackend
        const configured = simple.speakers ?? []
        if (simple.autoPullSpeaker === false) return configured

        // 失败不吞：抛给 Pipeline，由它标记「讲者列表未拉全」并后台重试
        const { response } = await this.fetchSpeakers(simple)
        return [...configured, ...parseSpeakersResponse(response)]
    }

    /** 诊断用：带 URL / 状态 / 原始响应片段 */
    async probeSpeakers(backend: Backend): Promise<SpeakerProbe> {
        const simple = backend as VitsSimpleApiBackend
        const label = simple.label ?? simple.type
        const configured = simple.speakers ?? []
        const started = Date.now()

        if (simple.autoPullSpeaker === false) {
            return {
                label,
                type: simple.type,
                requested: false,
                ok: configured.length > 0,
                ms: 0,
                count: configured.length,
                sample: configured.slice(0, 5).map((item) => item.name),
                hint: 'autoPullSpeaker=false：只用配置里写死的讲者'
            }
        }

        const url = this.url(simple.url, '/voice/speakers')

        try {
            const response = await this.ctx.http.get(url, {
                headers: this.buildHeaders(simple),
                timeout: simple.timeout ?? 15000
            })
            const pulled = parseSpeakersResponse(response)
            const all = [...configured, ...pulled]

            return {
                label,
                type: simple.type,
                requested: true,
                url,
                ok: true,
                status: 200,
                ms: Date.now() - started,
                count: all.length,
                sample: all.slice(0, 5).map((item) => item.name),
                hint:
                    pulled.length === 0
                        ? '接口通了但讲者列表为空：确认后端已加载模型'
                        : undefined
            }
        } catch (error) {
            const status =
                (error as any)?.status ?? (error as any)?.response?.status
            const errorClass = classifyError(error)
            const raw = (error as any)?.response?.data
            const body = typeof raw === 'string' ? raw.slice(0, 200) : undefined

            return {
                label,
                type: simple.type,
                requested: true,
                url,
                ok: false,
                status,
                ms: Date.now() - started,
                count: 0,
                error: `${errorClass}${status ? ` ${status}` : ''}: ${
                    (error as Error)?.message ?? error
                }${body ? ` · body: ${body}` : ''}`,
                hint: speakersErrorHint(status, errorClass)
            }
        }
    }

    private async fetchSpeakers(
        backend: VitsSimpleApiBackend
    ): Promise<{ url: string; response: unknown }> {
        const url = this.url(backend.url, '/voice/speakers')
        try {
            const response = await this.ctx.http.get(url, {
                headers: this.buildHeaders(backend),
                timeout: backend.timeout ?? 15000
            })
            return { url, response }
        } catch (error) {
            const wrapped = wrapError(error, 'vits-simple-api:speakers')
            ;(wrapped as unknown as { url?: string }).url = url
            throw wrapped
        }
    }

    private buildHeaders(backend: VitsSimpleApiBackend): Record<string, string> {
        const headers = this.headers(backend)

        if (backend.apiKey) headers['X-API-KEY'] = backend.apiKey

        if (
            backend.username &&
            backend.password &&
            !headers['Authorization']
        ) {
            headers['Authorization'] =
                'Basic ' +
                Buffer.from(
                    `${backend.username}:${backend.password}`
                ).toString('base64')
        }

        return headers
    }

    private buildPayload(
        request: SynthesizeRequest,
        speaker: SimpleSpeaker,
        type: string
    ): Record<string, unknown> {
        const payload: Record<string, unknown> = {
            text: request.text,
            lang: mapLanguage(
                request.language ?? speaker.languages?.[0] ?? 'zh'
            )
        }

        if (speaker.id != null) payload.id = speaker.id

        for (const key of ALLOWED[type] ?? ALLOWED.VITS) {
            if (speaker[key] != null) payload[key] = speaker[key]
        }

        // 语言字段必须在透传之后再归一化，否则会被原始值覆盖
        if (speaker.type === 'GPT-SOVITS') {
            payload.prompt_lang = mapLanguage(
                String(speaker.prompt_lang ?? request.language ?? 'zh')
            )
        }

        // 参考音频是可选的文件字段，单独标记给调用方处理
        if (type === 'GPT-SOVITS' && speaker.reference_audio) {
            payload.reference_audio = speaker.reference_audio
        }

        return payload
    }
}

/**
 * 解析 `/voice/speakers` 的返回。标准形状是
 * `{"VITS":[{"id":0,"name":"x","lang":["zh"]}], "HUBERT-VITS":[…]}`，
 * 同时兼容数组、`{data:[…]}`、`{speakers:[…]}`、以 id 为键的对象等写法。
 */
export function parseSpeakersResponse(response: unknown): SpeakerBase[] {
    const result: SpeakerBase[] = []

    const push = (item: any, type?: string) => {
        if (!item || typeof item !== 'object') return
        const name = item.name ?? item.speaker_name ?? item.speaker ?? item.id
        if (name == null) return

        const speaker: SpeakerBase = {
            ...item,
            name: String(name),
            languages: readLanguages(item)
        }
        if (type) speaker.type = type
        result.push(speaker)
    }

    const pushList = (list: unknown, type?: string) => {
        if (Array.isArray(list)) {
            for (const item of list) push(item, type)
            return
        }
        if (list && typeof list === 'object') {
            for (const item of Object.values(list as Record<string, unknown>)) {
                push(item, type)
            }
        }
    }

    if (Array.isArray(response)) {
        pushList(response)
        return result
    }
    if (!response || typeof response !== 'object') return result

    const root = response as Record<string, unknown>
    if (root.data != null) return (pushList(root.data), result)
    if (root.speakers != null) return (pushList(root.speakers), result)

    for (const [type, value] of Object.entries(root)) {
        // HUBERT-VITS 的接口是 /voice/hubert-vits，本插件不接，直接跳过
        if (type === 'HUBERT-VITS') continue
        if (!Array.isArray(value) && (!value || typeof value !== 'object')) {
            continue
        }
        pushList(value, type)
    }

    return result
}

function readLanguages(item: any): string[] {
    const raw = item.languages ?? item.lang ?? item.language
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list
        .map((value) => String(value).toUpperCase())
        .filter((value) => value.length > 0)
}

/** 把常见失败翻译成一句可操作的提示 */
export function speakersErrorHint(
    status?: number,
    errorClass?: ErrorClass
): string | undefined {
    if (status === 404) {
        return '404：确认 url 是 vits-simple-api 根地址（别带 /voice），且版本支持 /voice/speakers'
    }
    if (status === 401 || status === 403) {
        return '鉴权失败：检查 apiKey，或 username / password'
    }
    if (errorClass === 'CONNECT') {
        return '连不上：确认后端已启动、地址与端口正确、防火墙放行'
    }
    if (errorClass === 'TIMEOUT') {
        return '超时：后端可能在加载模型，稍后再试'
    }
    if (errorClass === 'SERVER') {
        return '后端 5xx：看后端日志'
    }
    return '返回不是预期的讲者格式，可对照 /voice/speakers 的原始内容'
}
