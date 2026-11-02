import { AudioResult, Backend, FishAudioBackend, SpeakerBase } from '../types'
import {
    AdapterContext,
    SynthesizeRequest,
    VitsAdapter,
    assertAudio,
    mimeFromFormat,
    toBuffer,
    wrapError
} from './base'

type FishSpeaker = SpeakerBase & {
    reference_id?: string
    format?: 'wav' | 'pcm' | 'mp3'
    chunk_length?: number
    normalize?: boolean
    latency?: 'normal' | 'balanced'
    mp3_bitrate?: number
}

const STRIP_KEYS = ['name', 'languages', 'text', 'reference_id', 'format']

export class FishAudioAdapter extends VitsAdapter {
    readonly type = 'fish-audio' as const

    constructor(ctx: AdapterContext) {
        super(ctx)
    }

    async synthesize(request: SynthesizeRequest): Promise<AudioResult> {
        const backend = request.backend as FishAudioBackend
        const speaker = request.speaker as FishSpeaker

        const payload = this.buildPayload(request, speaker)
        const baseUrl = (backend.baseUrl ?? 'https://api.fish.audio').replace(
            /\/+$/,
            ''
        )
        const url = `${baseUrl}/v1/tts`

        const headers = this.headers(backend, {
            Authorization: `Bearer ${backend.apiKey ?? ''}`,
            'Content-Type': 'application/json'
        })

        try {
            const data = await this.ctx.http.post(url, payload, {
                headers,
                responseType: 'arraybuffer',
                timeout: request.timeout
            })

            return {
                data: assertAudio(toBuffer(data)),
                mime: mimeFromFormat(String(payload.format ?? 'wav'))
            }
        } catch (error) {
            throw wrapError(error, 'fish-audio')
        }
    }

    private buildPayload(
        request: SynthesizeRequest,
        speaker: FishSpeaker
    ): Record<string, unknown> {
        const extras: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(speaker)) {
            if (STRIP_KEYS.includes(key) || value == null) continue
            extras[key] = value
        }

        return {
            chunk_length: 50,
            normalize: true,
            mp3_bitrate: 64,
            latency: 'normal',
            ...extras,
            text: request.text,
            format: speaker.format ?? 'wav',
            reference_id: speaker.reference_id
        }
    }
}
