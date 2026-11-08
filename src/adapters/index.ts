import { Backend } from '../types'
import { AdapterContext, VitsAdapter } from './base'
import { VitsSimpleApiAdapter } from './vits-simple-api'
import { GptSovits2Adapter } from './gpt-sovits2'
import { GsvApiAdapter } from './gsv-api'
import { FishAudioAdapter } from './fish-audio'
import { QQVoiceAdapter } from './qq-voice'

export type AdapterMap = Record<Backend['type'], VitsAdapter>

export function createAdapters(ctx: AdapterContext): AdapterMap {
    return {
        'vits-simple-api': new VitsSimpleApiAdapter(ctx),
        'GPT-SoVITS2': new GptSovits2Adapter(ctx),
        'gsv-api': new GsvApiAdapter(ctx),
        'fish-audio': new FishAudioAdapter(ctx),
        'qq-voice': new QQVoiceAdapter(ctx)
    }
}

export { VitsAdapter } from './base'
export * from './base'
export { VitsSimpleApiAdapter } from './vits-simple-api'
export { GptSovits2Adapter } from './gpt-sovits2'
export { GsvApiAdapter } from './gsv-api'
export { FishAudioAdapter } from './fish-audio'
export { QQVoiceAdapter } from './qq-voice'

