import {
    AudioResult,
    Backend,
    GptSovits2Backend,
    SpeakerBase
} from '../types'
import {
    AdapterContext,
    SynthesizeRequest,
    VitsAdapter,
    assertAudio,
    mapLanguage,
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

const WEIGHT_KEYS = ['name', 'gpt_weights', 'sovits_weights', 'languages']

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
        const stateKey = backend.label ?? backend.url

        if (speaker.sovits_weights) {
            await this.setWeights(
                backend,
                stateKey,
                'sovits',
                speaker.sovits_weights,
                request.timeout
            )
        }
        if (speaker.gpt_weights) {
            await this.setWeights(
                backend,
                stateKey,
                'gpt',
                speaker.gpt_weights,
                request.timeout
            )
        }

        const payload = this.buildPayload(backend, speaker, request)
        const url = this.url(backend.url, '/tts')

        try {
            const data = await this.ctx.http.post(url, payload, {
                headers: this.headers(backend, {
                    'Content-Type': 'application/json'
                }),
                responseType: 'arraybuffer',
                timeout: request.timeout
            })

            return {
                data: assertAudio(toBuffer(data)),
                mime:
                    payload.media_type === 'mp3'
                        ? 'audio/mpeg'
                        : 'audio/wav'
            }
        } catch (error) {
            throw wrapError(error, 'GPT-SoVITS2')
        }
    }

    private async setWeights(
        backend: GptSovits2Backend,
        stateKey: string,
        which: 'gpt' | 'sovits',
        weightsPath: string,
        timeout: number
    ): Promise<void> {
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
                    `GPT-SoVITS2 切换 ${which} 底模失败：${JSON.stringify(response).slice(0, 120)}`
                )
            }

            state[which] = weightsPath
            this.weights.set(stateKey, state)
        } catch (error) {
            throw wrapError(error, `GPT-SoVITS2:set_${which}_weights`)
        }
    }

    private buildPayload(
        backend: GptSovits2Backend,
        speaker: GptSpeaker,
        request: SynthesizeRequest
    ): Record<string, unknown> {
        const overrides: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(speaker)) {
            if (WEIGHT_KEYS.includes(key)) continue
            if (key === 'text' || value == null) continue
            overrides[key] = value
        }

        const payload: Record<string, unknown> = {
            ...(backend.config ?? {}),
            ...overrides,
            text: request.text,
            text_lang: mapLanguage(
                speaker.text_lang ??
                    request.language ??
                    speaker.languages?.[0] ??
                    'zh'
            ),
            streaming_mode: false
        }

        if (payload.speed != null) {
            payload.speed_factor = payload.speed
            delete payload.speed
        }

        if (payload.prompt_lang != null) {
            payload.prompt_lang = mapLanguage(String(payload.prompt_lang))
        }

        if (payload.aux_ref_audio_paths == null) {
            payload.aux_ref_audio_paths = []
        }

        return payload
    }
}
