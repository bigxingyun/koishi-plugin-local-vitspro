import { SplitMode } from '../types'

export interface SplitOptions {
    mode: SplitMode
    /** 主标点找不到时是否允许降级（逗号 → 空格 → 硬切） */
    allowFallback: boolean
    minSegmentChars: number
    /** 单段硬上限（字符数，按 JS 长度计） */
    maxSegmentChars: number
    maxSegments: number
}

export const DEFAULT_SPLIT: SplitOptions = {
    mode: 'zh_period',
    allowFallback: true,
    minSegmentChars: 8,
    maxSegmentChars: 120,
    maxSegments: 8
}

const MARKS: Record<
    SplitMode,
    { primary: string; secondary: string }
> = {
    none: { primary: '', secondary: '' },
    zh_period: { primary: '。！？!?…', secondary: '，；、' },
    zh_comma: { primary: '，；、', secondary: ' ' },
    en_period: { primary: '.!?', secondary: ',;:' },
    en_comma: { primary: ',;:', secondary: ' ' }
}

const CLOSERS = '”’）)》」』】]}"\''
const OPENERS: Record<string, string> = {
    '“': '”',
    '‘': '’',
    '（': '）',
    '(': ')',
    '《': '》',
    '「': '」',
    '『': '』',
    '【': '】',
    '[': ']'
}

/**
 * 切片：按配置在标点处切，保护引号/括号/URL/小数/缩写内部，
 * 过短的段并入相邻段，超过上限则合并尾段。
 */
export function splitText(text: string, options?: Partial<SplitOptions>): string[] {
    const opts: SplitOptions = { ...DEFAULT_SPLIT, ...options }
    const source = text.trim()
    if (!source) return []

    const max = Math.max(4, opts.maxSegmentChars)
    if (opts.mode === 'none' || source.length <= max) {
        return capSegments(
            mergeShort(hardChunk(source, max), opts.minSegmentChars),
            opts.maxSegments
        )
    }

    const protect = buildProtectedMask(source)
    const marks = MARKS[opts.mode]
    const segments: string[] = []
    let cursor = 0

    while (cursor < source.length) {
        const windowEnd = Math.min(cursor + max, source.length)
        let cut = findCut(
            source,
            cursor,
            windowEnd,
            marks.primary,
            protect,
            false
        )

        if (cut === -1 && opts.allowFallback) {
            cut = findCut(
                source,
                cursor,
                windowEnd,
                marks.secondary,
                protect,
                true
            )
        }

        if (cut === -1 || cut <= cursor) {
            cut = hardCut(source, cursor, windowEnd, protect)
        }

        if (cut > windowEnd) cut = windowEnd

        segments.push(source.slice(cursor, cut))
        cursor = cut
    }

    return capSegments(
        mergeShort(
            segments.map((s) => s.trim()).filter(Boolean),
            opts.minSegmentChars
        ),
        opts.maxSegments
    )
}

/** 标记某个下标是否位于保护区间内（区间内部不允许切） */
function buildProtectedMask(text: string): boolean[] {
    const mask = new Array<boolean>(text.length).fill(false)

    const protectRange = (start: number, end: number) => {
        for (let i = start; i < end && i < text.length; i++) mask[i] = true
    }

    // 引号 / 括号成对保护
    for (const [open, close] of Object.entries(OPENERS)) {
        let from = 0
        while (from < text.length) {
            const start = text.indexOf(open, from)
            if (start === -1) break
            const end = text.indexOf(close, start + 1)
            if (end === -1) break
            protectRange(start, end + 1)
            from = end + 1
        }
    }

    // URL
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'）】]*/g)) {
        protectRange(match.index ?? 0, (match.index ?? 0) + match[0].length)
    }

    // 小数
    for (const match of text.matchAll(/\d+\.\d+/g)) {
        protectRange(match.index ?? 0, (match.index ?? 0) + match[0].length)
    }

    // 英文缩写
    for (const match of text.matchAll(
        /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e)\./gi
    )) {
        protectRange(match.index ?? 0, (match.index ?? 0) + match[0].length)
    }

    return mask
}

function findCut(
    text: string,
    from: number,
    to: number,
    marks: string,
    protect: boolean[],
    spacesOnly: boolean
): number {
    if (!marks) return -1

    for (let i = to - 1; i >= from; i--) {
        const char = text[i]
        const isMark = spacesOnly ? char === ' ' : marks.includes(char)
        if (!isMark) continue
        if (protect[i]) continue

        // 英文句点：左边不能是数字，右边必须是空白或结尾
        if (char === '.') {
            const prev = text[i - 1] ?? ''
            const next = text[i + 1] ?? ''
            if (/\d/.test(prev)) continue
            if (next !== '' && !/\s/.test(next)) continue
        }

        let end = i + 1
        while (end < text.length && marks.includes(text[end])) end++
        while (end < text.length && CLOSERS.includes(text[end])) end++
        return end
    }

    return -1
}

function hardCut(
    text: string,
    from: number,
    to: number,
    protect?: boolean[]
): number {
    for (let i = to - 1; i > from; i--) {
        if (protect?.[i]) continue
        if (text[i] === ' ') return i + 1
        if ('，。！？；、,.;!?'.includes(text[i])) return i + 1
    }
    return Math.max(to, from + 1)
}

function hardChunk(text: string, max: number): string[] {
    const chunks: string[] = []
    let cursor = 0
    while (cursor < text.length) {
        const to = Math.min(cursor + max, text.length)
        const cut = to === text.length ? to : hardCut(text, cursor, to)
        chunks.push(text.slice(cursor, cut))
        cursor = cut
    }
    return chunks
}

function mergeShort(segments: string[], minChars: number): string[] {
    if (segments.length <= 1) return segments

    const result: string[] = []
    for (const segment of segments) {
        if (
            result.length > 0 &&
            Array.from(segment).length < minChars
        ) {
            result[result.length - 1] += segment
            continue
        }
        result.push(segment)
    }

    return result
}

function capSegments(segments: string[], maxSegments: number): string[] {
    const limit = Math.max(1, maxSegments)
    while (segments.length > limit) {
        const last = segments.pop()!
        segments[segments.length - 1] += last
    }
    return segments
}

