import { describe, expect, it } from 'vitest'
import { splitText } from '../src/core/split'
import { sentenceOfLength, textOfLength } from './helpers'

describe('splitText', () => {
    it('zh_period：在句末切', () => {
        const segments = splitText('第一句。第二句。第三句。', {
            mode: 'zh_period',
            minSegmentChars: 1,
            maxSegmentChars: 6
        })

        expect(segments).toEqual(['第一句。', '第二句。', '第三句。'])
    })

    it('zh_comma：在逗号切', () => {
        const text = '甲，乙，丙，丁，戊，己，庚，辛'
        const segments = splitText(text, {
            mode: 'zh_comma',
            minSegmentChars: 1,
            maxSegmentChars: 8
        })

        expect(segments.length).toBeGreaterThan(1)
        expect(segments.join('')).toBe(text)
    })

    it('zh_period：找不到句号时降级到逗号', () => {
        const segments = splitText('甲，乙，丙，丁，戊，己', {
            mode: 'zh_period',
            minSegmentChars: 1,
            maxSegmentChars: 4,
            allowFallback: true
        })

        expect(segments.length).toBeGreaterThan(1)
    })

    it('allowFallback=false 时只认主标点', () => {
        const segments = splitText('甲，乙，丙，丁，戊，己', {
            mode: 'zh_period',
            minSegmentChars: 1,
            maxSegmentChars: 4,
            allowFallback: false
        })

        expect(segments.length).toBeGreaterThan(1)
        // 没有句号，只能硬切
        expect(segments.join('')).toBe('甲，乙，丙，丁，戊，己')
    })

    it('none：只按硬上限切', () => {
        const segments = splitText(textOfLength(250), {
            mode: 'none',
            maxSegmentChars: 100,
            minSegmentChars: 1
        })

        expect(segments.length).toBe(3)
        expect(segments.every((segment) => segment.length <= 100)).toBe(true)
    })

    it('en_period：英文句点后要有空白才切', () => {
        const segments = splitText('Hello world. This is fine. Done', {
            mode: 'en_period',
            maxSegmentChars: 20,
            minSegmentChars: 1
        })

        expect(segments).toEqual(['Hello world.', 'This is fine.', 'Done'])
    })

    it('保护 URL 内部的句点', () => {
        const segments = splitText('https://a.b/c 结尾继续。', {
            mode: 'en_period',
            maxSegmentChars: 15,
            minSegmentChars: 1
        })

        expect(segments[0]).toContain('https://a.b/c')
    })

    it('保护引号内部不切', () => {
        const segments = splitText('“你好。再见。”然后走了。', {
            mode: 'zh_period',
            maxSegmentChars: 12,
            minSegmentChars: 1
        })

        expect(segments[0].startsWith('“')).toBe(true)
        expect(segments[0].includes('”')).toBe(true)
        expect(segments.join('')).toBe('“你好。再见。”然后走了。')
    })

    it('过短的段并入相邻段', () => {
        const segments = splitText('嗯。好。今天天气不错。', {
            mode: 'zh_period',
            minSegmentChars: 8
        })

        expect(segments).toHaveLength(1)
    })

    it('段数上限会把尾段合并', () => {
        const text = sentenceOfLength(400)
        const segments = splitText(text, {
            mode: 'zh_period',
            minSegmentChars: 1,
            maxSegmentChars: 50,
            maxSegments: 3
        })

        expect(segments).toHaveLength(3)
        expect(segments.join('')).toBe(text)
    })

    it('300 字中文按 60 字上限切成 5 段', () => {
        const segments = splitText(sentenceOfLength(300), {
            mode: 'zh_period',
            minSegmentChars: 8,
            maxSegmentChars: 60,
            maxSegments: 8
        })

        expect(segments.length).toBe(5)
        expect(segments.every((segment) => segment.length <= 60)).toBe(true)
    })

    it('不丢字符：所有模式拼回去都等于原文', () => {
        const text = sentenceOfLength(180)
        for (const mode of [
            'zh_period',
            'zh_comma',
            'en_period',
            'en_comma',
            'none'
        ] as const) {
            const segments = splitText(text, {
                mode,
                minSegmentChars: 4,
                maxSegmentChars: 60,
                maxSegments: 20
            })
            expect(segments.join('').trim()).toBe(text.trim())
        }
    })
})
