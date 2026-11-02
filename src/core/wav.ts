/** 只处理 PCM（含 EXTENSIBLE 下的 PCM），不做任何转码 */
export interface WavFormat {
    audioFormat: number
    channels: number
    sampleRate: number
    byteRate: number
    blockAlign: number
    bitsPerSample: number
}

export interface WavData {
    format: WavFormat
    data: Buffer
}

const PCM = 1
const EXTENSIBLE = 0xfffe

export function isWav(buffer: Buffer): boolean {
    return (
        buffer.length >= 44 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WAVE'
    )
}

/** 解析 RIFF，返回 fmt 与 data；结构不合法返回 null */
export function parseWav(buffer: Buffer): WavData | null {
    if (!isWav(buffer)) return null

    let offset = 12
    let format: WavFormat | null = null
    let data: Buffer | null = null

    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8

        if (id === 'fmt ') {
            if (buffer.length < body + 16) return null
            const audioFormat = buffer.readUInt16LE(body)
            const channels = buffer.readUInt16LE(body + 2)
            const sampleRate = buffer.readUInt32LE(body + 4)
            const byteRate = buffer.readUInt32LE(body + 8)
            const blockAlign = buffer.readUInt16LE(body + 12)
            const bitsPerSample = buffer.readUInt16LE(body + 14)

            format = {
                // EXTENSIBLE 的子格式 GUID 前两字节就是真实格式
                audioFormat:
                    audioFormat === EXTENSIBLE && size >= 40
                        ? buffer.readUInt16LE(body + 24)
                        : audioFormat,
                channels,
                sampleRate,
                byteRate,
                blockAlign,
                bitsPerSample
            }
        } else if (id === 'data') {
            const end = Math.min(body + size, buffer.length)
            data = buffer.subarray(body, end)
        }

        // chunk 按偶数字节对齐
        offset = body + size + (size % 2)
    }

    if (!format || !data) return null
    return { format, data }
}

/** 用规范 44 字节头重新封装 PCM 数据 */
export function encodeWav(data: Buffer, format: WavFormat): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(PCM, 20)
    header.writeUInt16LE(format.channels, 22)
    header.writeUInt32LE(format.sampleRate, 24)
    header.writeUInt32LE(format.byteRate, 28)
    header.writeUInt16LE(format.blockAlign, 32)
    header.writeUInt16LE(format.bitsPerSample, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
}

/** 采样率/声道/位深/编码任一不同就不能拼 */
export function sameFormat(a: WavFormat, b: WavFormat): boolean {
    return (
        a.audioFormat === b.audioFormat &&
        a.channels === b.channels &&
        a.sampleRate === b.sampleRate &&
        a.bitsPerSample === b.bitsPerSample &&
        a.blockAlign === b.blockAlign &&
        a.byteRate === b.byteRate
    )
}

/** 由字节数推算时长（秒），非 PCM 返回 0 */
export function wavDurationSeconds(buffer: Buffer): number {
    const parsed = parseWav(buffer)
    if (!parsed || !parsed.format.byteRate) return 0
    return parsed.data.length / parsed.format.byteRate
}

/** 生成一段静音 PCM WAV，供测试与基准探针使用 */
export function buildSilenceWav(
    seconds: number,
    format: Partial<WavFormat> = {}
): Buffer {
    const channels = format.channels ?? 1
    const sampleRate = format.sampleRate ?? 16000
    const bitsPerSample = format.bitsPerSample ?? 16
    const blockAlign = (channels * bitsPerSample) / 8
    const byteRate = sampleRate * blockAlign
    const frames = Math.max(1, Math.round(sampleRate * seconds))
    const data = Buffer.alloc(frames * blockAlign)

    return encodeWav(data, {
        audioFormat: PCM,
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample
    })
}
