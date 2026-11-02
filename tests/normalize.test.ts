import { describe, expect, it } from 'vitest'
import {
    decodeEntities,
    isEffectivelyEmpty,
    normalize,
    stripEmoji,
    stripMarkdown
} from '../src/core/normalize'
import { characterVoiceMessage } from './helpers'

describe('normalize', () => {
    it('解包 chatluna-character 的 output/message/voice 并读取 id', () => {
        const result = normalize(characterVoiceMessage('今天天气不错，我们出去走走吧。', 7))

        expect(result.text).toBe('今天天气不错，我们出去走走吧。')
        expect(result.speakerHint).toBe(7)
        expect(result.hadMarkup).toBe(true)
        expect(result.unknownTags).toEqual([])
    })

    it('多个 message 块直接拼接', () => {
        const input =
            '<message><voice>第一句。</voice></message><message><voice>第二句。</voice></message>'

        expect(normalize(input).text).toBe('第一句。第二句。')
    })

    it('blockJoin 可以给多个块插入连接符', () => {
        const input =
            '<message><voice>第一句</voice></message><message><voice>第二句</voice></message>'

        expect(normalize(input, { blockJoin: '，' }).text).toBe('第一句，第二句')
    })

    it('二次序列化的实体会被反转义并解包', () => {
        const result = normalize('&lt;message&gt;你好&amp;欢迎&lt;/message&gt;')

        expect(result.text).toBe('你好&欢迎')
        expect(result.hadMarkup).toBe(true)
    })

    it('元素只保留文本', () => {
        const input = '<message><at id="1"/>你好<image url="https://x/y.png"/></message>'

        expect(normalize(input).text).toBe('你好')
    })

    it('去掉 Markdown 结构、链接只留文字、不朗读 URL', () => {
        const input =
            '**重点**、[链接](https://example.com/a)、`code`、~~删除~~、https://a.b/c'

        const text = normalize(input).text

        expect(text).toContain('重点')
        expect(text).toContain('链接')
        expect(text).toContain('code')
        expect(text).toContain('删除')
        expect(text).not.toContain('*')
        expect(text).not.toContain('http')
    })

    it('纯文本原样通过', () => {
        const result = normalize('你好，世界。')

        expect(result.text).toBe('你好，世界。')
        expect(result.hadMarkup).toBe(false)
        expect(result.speakerHint).toBeUndefined()
    })

    it('只有标签时归一化为空', () => {
        const result = normalize('<message><voice></voice></message>')

        expect(result.text).toBe('')
        expect(isEffectivelyEmpty(result.text)).toBe(true)
    })

    it('只有 emoji 时视为空', () => {
        const result = normalize('<message><voice>😀😀</voice></message>')

        expect(isEffectivelyEmpty(result.text)).toBe(true)
    })

    it('newlineAs=period 会把换行变成句号', () => {
        expect(normalize('第一行\n第二行', { newlineAs: 'period' }).text).toBe(
            '第一行。第二行'
        )
    })

    it('未知标签保留并上报', () => {
        const result = normalize('<message><foo>bar</foo></message>')

        expect(result.unknownTags).toContain('foo')
        expect(result.text).toContain('bar')
    })

    it('extraTags 可以解包额外标签', () => {
        const result = normalize('<message><foo>bar</foo></message>', {
            extraTags: ['foo']
        })

        expect(result.text).toBe('bar')
    })
})

describe('normalize helpers', () => {
    it('decodeEntities 支持命名实体与数字实体', () => {
        expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;&#20320;&#x4f60;')).toBe(
            '&<>"\' 你你'
        )
    })

    it('stripMarkdown 丢弃代码块与图片', () => {
        expect(stripMarkdown('前```js\nconst a = 1\n```后')).toBe('前后')
        expect(stripMarkdown('![图](https://x/y.png)好')).toBe('好')
    })

    it('stripEmoji 去掉 emoji 与变体选择符', () => {
        expect(stripEmoji('你好😀👍🏻')).toBe('你好')
    })
})
