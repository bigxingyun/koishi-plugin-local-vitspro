/**
 * 可发音字数：阈值判断与耗时估算共用同一把尺子。
 *
 * - 汉字 / 假名 / 全角字符：1
 * - 拉丁单词：2（一个英文单词的朗读时长约等于 2 个汉字）
 * - 数字：1（连续数字算一个词，取 1）
 * - 标点、空白、符号：0
 */
export function speakableLength(text: string): number {
    if (!text) return 0

    let count = 0
    let inLatinWord = false
    let inDigitRun = false

    for (const char of text) {
        const cp = char.codePointAt(0)!
        const cjk = isCjk(cp)
        const latin = isLatin(cp)
        const digit = cp >= 0x30 && cp <= 0x39

        if (cjk) {
            count += 1
            inLatinWord = false
            inDigitRun = false
            continue
        }

        if (latin) {
            if (!inLatinWord) count += 2
            inLatinWord = true
            inDigitRun = false
            continue
        }

        inLatinWord = false

        if (digit) {
            if (!inDigitRun) count += 1
            inDigitRun = true
            continue
        }

        inDigitRun = false
    }

    return count
}

/** 粗略判断“有没有值得朗读的内容”（纯标点/空白视为空） */
export function hasSpeakableContent(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text)
}

function isCjk(cp: number): boolean {
    if (cp >= 0x3000 && cp <= 0x303f) return false // CJK 标点不算字数
    return (
        (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
        (cp >= 0x3400 && cp <= 0x4dbf) || // Ext A
        (cp >= 0xf900 && cp <= 0xfaff) || // Compatibility
        (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana / Katakana
        (cp >= 0xac00 && cp <= 0xd7af) // Hangul
    )
}

function isLatin(cp: number): boolean {
    return (
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a) ||
        (cp >= 0xc0 && cp <= 0x24f && !(cp >= 0xd7 && cp <= 0xd8))
    )
}
