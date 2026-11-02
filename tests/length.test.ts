import { describe, expect, it } from 'vitest'
import { hasSpeakableContent, speakableLength } from '../src/core/length'

describe('speakableLength', () => {
    it('汉字按 1 字计', () => {
        expect(speakableLength('你好世界')).toBe(4)
    })

    it('英文单词按 2 字计', () => {
        expect(speakableLength('hello world')).toBe(4)
    })

    it('中英混排', () => {
        expect(speakableLength('中文abc')).toBe(4)
    })

    it('数字连续段按 1 字计', () => {
        expect(speakableLength('123')).toBe(1)
        expect(speakableLength('12 34')).toBe(2)
    })

    it('标点与空白不计入', () => {
        expect(speakableLength('你好，世界！  ')).toBe(4)
    })

    it('假名与韩文按 1 字计', () => {
        expect(speakableLength('こんにちは')).toBe(5)
        expect(speakableLength('안녕')).toBe(2)
    })

    it('空文本为 0', () => {
        expect(speakableLength('')).toBe(0)
    })
})

describe('hasSpeakableContent', () => {
    it('纯标点为 false', () => {
        expect(hasSpeakableContent('。！？，')).toBe(false)
    })

    it('有文字为 true', () => {
        expect(hasSpeakableContent('嗯')).toBe(true)
    })
})
