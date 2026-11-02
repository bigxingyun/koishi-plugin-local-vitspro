import { describe, expect, it } from 'vitest'
import { Pipeline } from '../src/core/pipeline'
import { VitsDegradeError } from '../src/core/errors'
import {
    characterVoiceMessage,
    createStubHttp,
    makeConfig,
    sentenceOfLength,
    silentLogger,
    simpleBackend
} from './helpers'

function pipelineWith() {
    const config = makeConfig({ backends: [simpleBackend()] })
    const { http, calls } = createStubHttp()
    const pipeline = new Pipeline({
        http,
        logger: silentLogger,
        config,
        backends: () => config.backends
    })
    return { pipeline, calls }
}

describe('chatluna-character 兼容', () => {
    it('真实序列化形态的长句 → 一条语音，且请求里没有标签', async () => {
        const { pipeline, calls } = pipelineWith()
        const text = sentenceOfLength(200)

        const element = await pipeline.say({
            input: `<output><message quote="987654321"><voice id="1">${text}</voice></message></output>`,
            session: {}
        })

        expect(element.type).toBe('audio')
        expect(calls.length).toBeGreaterThan(1)

        for (const call of calls) {
            const sent = String((call.body as FormData).get('text'))
            expect(sent).not.toContain('<')
            expect(sent).not.toContain('voice')
            expect(sent).not.toContain('quote')
        }
    })

    it('抛出的 VitsDegradeError 带着可用的纯文本，便于 character 兜底', async () => {
        const { pipeline } = pipelineWith()
        const text = sentenceOfLength(400)

        let caught: VitsDegradeError | undefined
        try {
            await pipeline.say({ input: characterVoiceMessage(text) })
        } catch (error) {
            caught = error as VitsDegradeError
        }

        expect(caught).toBeInstanceOf(VitsDegradeError)
        expect(caught!.code).toBe('TOO_LONG')
        expect(caught!.text).toBe(text)
        expect(caught!.text).not.toContain('<')
    })

    it('chatluna 核心渲染器路径（无标记 + session）降级时保住文字', async () => {
        const { pipeline } = pipelineWith()

        const element = await pipeline.say({
            input: sentenceOfLength(2100),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        expect(element.type).toBe('text')
        expect(String(element.attrs.content)).toHaveLength(2100)
    })
})

