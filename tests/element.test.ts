import { describe, expect, it } from 'vitest'
import { Pipeline } from '../src/core/pipeline'
import type { ElementLike } from '../src/core/element'
import {
    createStubHttp,
    makeConfig,
    sentenceOfLength,
    silentLogger,
    simpleBackend
} from './helpers'

function audioOf(element: ElementLike): Buffer {
    const src = String((element.attrs as any).src ?? '')
    const base64 = src.split('base64,')[1] ?? ''
    return Buffer.from(base64, 'base64')
}

describe('Pipeline element 结构', () => {
    it('音频元素结构与 koishi h.audio 一致', async () => {
        const config = makeConfig({ backends: [simpleBackend()] })
        const { http } = createStubHttp()
        const pipeline = new Pipeline({
            http,
            logger: silentLogger,
            config,
            backends: () => config.backends
        })

        const element = await pipeline.say({
            input: sentenceOfLength(20),
            speaker_id: 0,
            session: {}
        })

        expect(element.type).toBe('audio')
        expect(String(element.attrs.src)).toMatch(/^data:.*;base64,/)
        expect(audioOf(element).length).toBeGreaterThan(44)
    })
})
