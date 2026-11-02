import { encodeWav, parseWav, sameFormat } from './wav'

export type MergeResult =
    | { ok: true; data: Buffer }
    | { ok: false; reason: 'empty' | 'not-wav' | 'format-mismatch' }

/**
 * 把多段 WAV 拼成一段：要求全部是合法 PCM WAV 且 fmt 完全一致。
 * 任何一段不满足就整组放弃（由调用方降级成多段发送）。
 */
export function mergeWavs(buffers: Buffer[]): MergeResult {
    if (buffers.length === 0) return { ok: false, reason: 'empty' }
    if (buffers.length === 1) {
        return parseWav(buffers[0])
            ? { ok: true, data: buffers[0] }
            : { ok: false, reason: 'not-wav' }
    }

    const parsed = buffers.map((buffer) => parseWav(buffer))
    if (parsed.some((item) => item == null)) {
        return { ok: false, reason: 'not-wav' }
    }

    const first = parsed[0]!
    for (const item of parsed.slice(1)) {
        if (!sameFormat(first.format, item!.format)) {
            return { ok: false, reason: 'format-mismatch' }
        }
    }

    return {
        ok: true,
        data: encodeWav(
            Buffer.concat(parsed.map((item) => item!.data)),
            first.format
        )
    }
}

/** 按 mime 判断能否走 WAV 拼接 */
export function canMerge(mime: string, buffers: Buffer[]): boolean {
    if (!/wav|wave|x-wav/i.test(mime)) return false
    return mergeWavs(buffers).ok
}
