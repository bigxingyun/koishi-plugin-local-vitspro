import { describe, expect, it } from 'vitest'
import {
    buildSilenceWav,
    encodeWav,
    parseWav,
    sameFormat,
    wavDurationSeconds
} from '../src/core/wav'
import { mergeWavs } from '../src/core/merge'

describe('wav', () => {
    it('解析自己生成的 WAV', () => {
        const buffer = buildSilenceWav(0.5, { sampleRate: 16000 })
        const parsed = parseWav(buffer)

        expect(parsed).not.toBeNull()
        expect(parsed!.format.sampleRate).toBe(16000)
        expect(parsed!.format.channels).toBe(1)
        expect(parsed!.format.bitsPerSample).toBe(16)
        expect(parsed!.data.length).toBe(16000)
    })

    it('时长按时长字段推算', () => {
        expect(wavDurationSeconds(buildSilenceWav(0.5))).toBeCloseTo(0.5, 3)
        expect(wavDurationSeconds(buildSilenceWav(2))).toBeCloseTo(2, 3)
    })

    it('encode/parse 往返一致', () => {
        const original = buildSilenceWav(0.2, { sampleRate: 8000 })
        const parsed = parseWav(original)!
        const again = parseWav(encodeWav(parsed.data, parsed.format))!

        expect(again.data.length).toBe(parsed.data.length)
        expect(sameFormat(again.format, parsed.format)).toBe(true)
    })

    it('非法数据返回 null', () => {
        expect(parseWav(Buffer.from('not a wav'))).toBeNull()
    })
})

describe('mergeWavs', () => {
    it('同参数拼接后时长相加', () => {
        const a = buildSilenceWav(0.5)
        const b = buildSilenceWav(0.3)
        const merged = mergeWavs([a, b])

        expect(merged.ok).toBe(true)
        if (!merged.ok) return
        expect(wavDurationSeconds(merged.data)).toBeCloseTo(0.8, 2)
    })

    it('单段直接返回', () => {
        const merged = mergeWavs([buildSilenceWav(0.4)])

        expect(merged.ok).toBe(true)
    })

    it('采样率不同则拒绝拼接', () => {
        const merged = mergeWavs([
            buildSilenceWav(0.5, { sampleRate: 16000 }),
            buildSilenceWav(0.5, { sampleRate: 22050 })
        ])

        expect(merged.ok).toBe(false)
        if (!merged.ok) expect(merged.reason).toBe('format-mismatch')
    })

    it('非 WAV 数据拒绝拼接', () => {
        const merged = mergeWavs([Buffer.from('abc'), buildSilenceWav(0.1)])

        expect(merged.ok).toBe(false)
        if (!merged.ok) expect(merged.reason).toBe('not-wav')
    })

    it('空数组', () => {
        expect(mergeWavs([]).ok).toBe(false)
    })
})
