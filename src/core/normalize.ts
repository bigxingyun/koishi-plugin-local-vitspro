import { hasSpeakableContent } from './length'

export interface TextOptions {
    stripMarkdown: boolean
    stripEmoji: boolean
    newlineAs: 'space' | 'period'
    /** 多个 `<message>` 块之间的连接符 */
    blockJoin: string
    /** 额外需要解包的标签名（保留内层文本） */
    extraTags: string[]
}

export interface NormalizeResult {
    /** 归一化后的可朗读文本 */
    text: string
    /** 从 `<voice id="N">` 里读到的讲者 id（0 表示未指定） */
    speakerHint?: number
    /** 输入里是否出现了 chatluna 的序列化标记 */
    hadMarkup: boolean
    /** 解析后仍然残留的未知标签名（用于 warn） */
    unknownTags: string[]
}

const MARKUP_RE = /<(message|output|message_part|voice)\b/i
const VOICE_RE = /<voice\b([^>]*)>([\s\S]*?)<\/voice>/gi
const VOICE_SELF_CLOSING_RE = /<voice\b[^>]*\/>/gi
const OUTPUT_RE = /<output>([\s\S]*?)<\/output>/i
const MESSAGE_TAG_RE = /<\/?message\b[^>]*>/gi
const MESSAGE_PART_TAG_RE = /<\/?message_part\b[^>]*>/gi
const EMPTY_TAG_RE = /<\/?(?:at|image|face|sticker|audio|video|file|quote|record)\b[^>]*\/?>/gi
const MARKDOWN_TAG_RE = /<\/?markdown\b[^>]*>/gi
const ANY_TAG_RE = /<([a-z][a-z0-9-]*)\b[^>]*>/gi

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'"
}

const DEFAULT_OPTIONS: TextOptions = {
    stripMarkdown: true,
    stripEmoji: true,
    newlineAs: 'space',
    blockJoin: '',
    extraTags: []
}

export function detectMarkup(input: string): boolean {
    return MARKUP_RE.test(input)
}

/**
 * 把 chatluna / chatluna-character 的序列化输入收敛成可朗读的纯文本。
 *
 * 顺序：解包容器 → 解包 voice 并取 id → 去 message 标签 → 去元素标签
 *      → 反转义 → 去 Markdown → 去 emoji → 换行归一 → 压缩空白
 */
export function normalize(
    input: string,
    options?: Partial<TextOptions>
): NormalizeResult {
    const opts: TextOptions = { ...DEFAULT_OPTIONS, ...options }
    const source = String(input ?? '')
    // 先反转义：chatluna 的二次序列化会把标签转义成 &lt;message&gt;
    const decoded = decodeEntities(source)
    const hadMarkup = detectMarkup(source) || detectMarkup(decoded)

    let text = decoded
    let speakerHint: number | undefined

    text = unwrapOutput(text)

    text = text.replace(VOICE_RE, (_all, attrs: string, inner: string) => {
        if (speakerHint == null) {
            const id = readId(attrs)
            if (id != null) speakerHint = id
        }
        return inner
    })
    text = text.replace(VOICE_SELF_CLOSING_RE, '')

    text = text.replace(EMPTY_TAG_RE, '')
    text = text.replace(MARKDOWN_TAG_RE, '')
    text = text.replace(MESSAGE_PART_TAG_RE, (tag: string, offset: number) => {
        if (tag.startsWith('</')) return ''
        return text.slice(0, offset).trim() ? opts.blockJoin : ''
    })
    text = text.replace(MESSAGE_TAG_RE, (tag: string, offset: number) => {
        if (tag.startsWith('</')) return ''
        return text.slice(0, offset).trim() ? opts.blockJoin : ''
    })

    for (const tag of opts.extraTags) {
        if (!/^[a-z][a-z0-9-]*$/i.test(tag)) continue
        const re = new RegExp(`</?${tag}\\b[^>]*>`, 'gi')
        text = text.replace(re, '')
    }

    const unknownTags = collectUnknownTags(text)

    // tag 解包后可能还残留实体（例如 &amp;lt;），再反转义一次
    text = decodeEntities(text)

    if (opts.stripMarkdown) text = stripMarkdown(text)
    if (opts.stripEmoji) text = stripEmoji(text)

    text = normalizeNewlines(text, opts.newlineAs)
    text = collapseWhitespace(text)

    return {
        text,
        speakerHint,
        hadMarkup,
        unknownTags
    }
}

/** 是否值得送去合成（纯标点/空白/emoji 已清空后为空） */
export function isEffectivelyEmpty(text: string): boolean {
    return !hasSpeakableContent(text)
}

function unwrapOutput(text: string): string {
    const match = OUTPUT_RE.exec(text)
    return match ? match[1] : text
}

function readId(attrs: string): number | undefined {
    const match = /\bid\s*=\s*["']?(\d+)["']?/i.exec(attrs)
    if (!match) return undefined
    const id = Number.parseInt(match[1], 10)
    return Number.isFinite(id) && id > 0 ? id : undefined
}

function collectUnknownTags(text: string): string[] {
    const tags: string[] = []
    ANY_TAG_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ANY_TAG_RE.exec(text)) != null) {
        const name = match[1].toLowerCase()
        if (!tags.includes(name)) tags.push(name)
    }
    return tags
}

export function decodeEntities(text: string): string {
    return text.replace(
        /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
        (all, body: string) => {
            if (body.startsWith('#x') || body.startsWith('#X')) {
                const cp = Number.parseInt(body.slice(2), 16)
                return Number.isFinite(cp) ? safeFromCodePoint(cp, all) : all
            }
            if (body.startsWith('#')) {
                const cp = Number.parseInt(body.slice(1), 10)
                return Number.isFinite(cp) ? safeFromCodePoint(cp, all) : all
            }
            return ENTITIES[body] ?? all
        }
    )
}

function safeFromCodePoint(cp: number, fallback: string): string {
    try {
        return String.fromCodePoint(cp)
    } catch {
        return fallback
    }
}

export function stripMarkdown(text: string): string {
    return (
        text
            // 代码块整体丢弃（朗读代码没有意义）
            .replace(/```[\s\S]*?```/g, '')
            // 行内代码保留内容
            .replace(/`([^`\n]*)`/g, '$1')
            // 图片丢弃
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
            // 链接保留文字
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            // 裸 URL 丢弃
            .replace(/https?:\/\/[^\s<>"'）】]*/g, '')
            // 标题
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            // 引用
            .replace(/^\s{0,3}>\s?/gm, '')
            // 列表符号
            .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
            // 分隔线
            .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '')
            // 表格分隔行
            .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
            // 强调
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            // 表格竖线
            .replace(/\|/g, ' ')
    )
}

export function stripEmoji(text: string): string {
    return text
        .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
        .replace(/[\u200B-\u200F\uFE0E\uFE0F]/gu, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
}

function normalizeNewlines(
    text: string,
    mode: 'space' | 'period'
): string {
    if (mode === 'period') {
        return text.replace(/\s*[\r\n]+\s*/g, (all, offset: number, full: string) => {
            const prev = full[offset - 1] ?? ''
            if (offset === 0) return ''
            if (/[。！？!?…，,；;、]/.test(prev)) return ''
            return '。'
        })
    }
    return text.replace(/\s*[\r\n]+\s*/g, ' ')
}

export function collapseWhitespace(text: string): string {
    return text
        .replace(/[ \t\u3000]+/g, ' ')
        .replace(/\s+([，。！？；：、）》」』】])/g, '$1')
        .replace(/([（《「『【])\s+/g, '$1')
        .trim()
}
