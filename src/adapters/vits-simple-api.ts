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
    VitsAdapter,
    assertAudio,
    mimeFromFormat,
    mapLanguage,
    toBuffer,
    wrapError
} from './base'
import { BackendError } from '../core/errors'

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

    async getSpeakers(backend: Backend): Promise<SpeakerBase[]> {
        const simple = backend as VitsSimpleApiBackend
        const configured = simple.speakers ?? []
        if (simple.autoPullSpeaker === false) return configured

        try {
            const url = this.url(simple.url, '/voice/speakers')
            const response = (await this.ctx.http.get(url, {
                headers: this.buildHeaders(simple),
                timeout: simple.timeout ?? 15000
            })) as Record<
                string,
                { name: string; id: number; languages?: string[]; lang?: string[] }[]
            >

            const pulled: SpeakerBase[] = []
            for (const [type, list] of Object.entries(response ?? {})) {
                if (type === 'HUBERT-VITS' || !Array.isArray(list)) continue
                for (const item of list) {
                    pulled.push({
                        name: item.name,
                        id: item.id,
                        type,
                        languages: (item.languages ?? item.lang ?? []).map(
                            (lang) => String(lang).toUpperCase()
                        )
                    })
                }
            }

            return [...configured, ...pulled]
        } catch (error) {
            this.ctx.logger.warn(
                `[vits-simple-api] 拉取讲者失败：${(error as Error)?.message ?? error}`
            )
            return configured
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
