import type { Config } from '../src/config'
import type { Backend, HttpClient, LoggerLike } from '../src/types'
import { buildSilenceWav } from '../src/core/wav'

export const silentLogger: LoggerLike = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
}

export function makeConfig(patch: Partial<Config> = {}): Config {
    const base: Config = {
        defaultSpeaker: '',
        backendsSource: 'schema',
        backendsFile: '',
        backends: [],
        text: {
            stripMarkdown: true,
            stripEmoji: true,
            newlineAs: 'space',
            blockJoin: '',
            extraTags: []
        },
        split: {
            mode: 'zh_period',
            allowFallback: true,
            minSegmentChars: 8,
            maxSegmentChars: 120,
            maxSegments: 8,
            concurrency: 2
        },
        aggregate: {
            type: 'auto',
            maxAudioSeconds: 55,
            partialPolicy: 'keep-ok'
        },
        timeout: {
            mode: 'auto',
            manual: 60000,
            factor: 2,
            min: 5000,
            max: 120000,
            overhead: 800,
            coldStart: 30000
        },
        breaker: {
            mode: 'auto',
            scope: 'backend',
            failureThreshold: 2,
            cooldown: 30000,
            maxCooldown: 600000
        },
        notice: { mode: 'session', interval: 600000 },
        toolCall: { minChars: 2, maxChars: 300 },
        degrade: { tool: 'error', service: 'text', command: 'text' },
        command: { maxTextChars: 2000 },
        bench: { enabled: true, ladder: [6, 12, 24], repeat: 2 },
        chatlunaTool: {
            enabled: false,
            name: 'vits_say',
            sendAudio: true,
            authority: 1
        }
    }

    return { ...base, ...patch }
}

export function simpleBackend(
    patch: Partial<Backend> = {}
): Backend {
    return {
        type: 'vits-simple-api',
        label: 'test',
        enabled: true,
        url: 'http://127.0.0.1:23456',
        autoPullSpeaker: false,
        speakers: [
            { name: '测试', id: 0, type: 'VITS', languages: ['ZH'] }
        ],
        ...patch
    } as Backend
}

export interface RecordedCall {
    method: 'GET' | 'POST'
    url: string
    body?: any
    config?: any
}

export type StubHandler = (
    call: RecordedCall,
    index: number
) => unknown | Promise<unknown>

export interface StubHttp {
    http: HttpClient
    calls: RecordedCall[]
}

/** 记录所有请求并按 handler 返回；默认返回 1 秒静音 WAV */
export function createStubHttp(handler?: StubHandler): StubHttp {
    const calls: RecordedCall[] = []

    const dispatch = async (call: RecordedCall) => {
        calls.push(call)
        if (handler) return handler(call, calls.length - 1)
        return buildSilenceWav(1)
    }

    const http: HttpClient = {
        get: (url: string, config?: Record<string, any>) =>
            dispatch({ method: 'GET', url, config }) as Promise<any>,
        post: (
            url: string,
            body?: any,
            config?: Record<string, any>
        ) => dispatch({ method: 'POST', url, body, config }) as Promise<any>
    }

    return { http, calls }
}

/** 生成一段能通过 merge 检查的 WAV（固定 16k/mono/16bit） */
export function wav(seconds = 1): Buffer {
    return buildSilenceWav(seconds, { sampleRate: 16000 })
}

/** chatluna-character 真实形态的序列化输入 */
export function characterVoiceMessage(text: string, id = 1): string {
    return `<output><message quote="123456"><voice id="${id}">${text}</voice></message></output>`
}

export function textOfLength(length: number): string {
    return '测'.repeat(length)
}

/** 由中文句子拼到指定长度（带标点，便于切片） */
export function sentenceOfLength(length: number): string {
    const unit = '今天天气不错，我们出去走走吧。'
    let text = ''
    while (text.length < length) text += unit
    return text.slice(0, length)
}


