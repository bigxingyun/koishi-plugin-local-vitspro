import {
    AutoConfig,
    Backend,
    HttpClient,
    SpeakerBase
} from '../types'
import { parseSpeakersResponse } from '../adapters/vits-simple-api'

export type DetectKind =
    | 'vits-simple-api'
    | 'gpt-sovits-v2'
    | 'gpt-sovits-v1'
    | 'unknown'

export interface DetectProbe {
    name: string
    url: string
    status?: number
    ok: boolean
    ms: number
    note?: string
}

export interface DetectResult {
    ok: boolean
    kind: DetectKind
    baseUrl: string
    probes: DetectProbe[]
    speakers?: SpeakerBase[]
    hint?: string
}

interface ProbeResponse {
    status?: number
    data?: unknown
}

/**
 * 地址归一化：允许用户填根地址、`/voice`、完整合成端点（`/voice/vits`、`/tts`）。
 * 返回时统一成不带尾部斜杠的根地址。
 */
export function normalizeBaseUrl(input: string): string {
    let url = String(input ?? '').trim()

    if (url && !/^https?:\/\//i.test(url)) {
        url = `http://${url}`
    }

    return url
        .replace(/\/+$/, '')
        .replace(
            /\/voice\/(?:vits|w2v2-vits|bert-vits2|gpt-sovits|hubert-vits)$/i,
            ''
        )
        .replace(/\/voice$/i, '')
        .replace(/\/tts$/i, '')
        .replace(/\/+$/, '')
}

export function authHeaders(auto: AutoConfig): Record<string, string> {
    const headers: Record<string, string> = {}

    if (auto.username || auto.password) {
        headers['Authorization'] =
            'Basic ' +
            Buffer.from(
                `${auto.username ?? ''}:${auto.password ?? ''}`
            ).toString('base64')
    }

    if (auto.token) headers['Authorization'] = `Bearer ${auto.token}`
    if (auto.apiKey) headers['X-API-KEY'] = auto.apiKey

    return headers
}

/**
 * 依次探测几个特征端点，判断这个地址到底是哪种后端 / 哪套协议。
 * 只发无副作用的 GET（绝不碰 `/control` 这类会重启服务的接口）。
 */
export async function detectBackend(
    http: HttpClient,
    auto: AutoConfig
): Promise<DetectResult> {
    const baseUrl = normalizeBaseUrl(auto.url)
    const probes: DetectProbe[] = []
    const timeout = Math.max(1000, auto.timeout || 5000)
    const headers = authHeaders(auto)

    if (!baseUrl) {
        return {
            ok: false,
            kind: 'unknown',
            baseUrl,
            probes,
            hint: '请先填写 auto.url'
        }
    }

    const probe = async (
        name: string,
        path: string
    ): Promise<{ response: ProbeResponse; probe: DetectProbe }> => {
        const url = `${baseUrl}${path}`
        const started = Date.now()

        try {
            const data = await http.get(url, { headers, timeout })
            const status = readStatus(data) ?? 200
            const item: DetectProbe = {
                name,
                url,
                status,
                ok: status >= 200 && status < 300,
                ms: Date.now() - started
            }
            probes.push(item)
            return { response: { status, data }, probe: item }
        } catch (error) {
            const status = readStatus(error)
            const item: DetectProbe = {
                name,
                url,
                status,
                ok: false,
                ms: Date.now() - started,
                note: (error as Error)?.message?.slice(0, 160)
            }
            probes.push(item)
            return { response: { status }, probe: item }
        }
    }

    // 1) vits-simple-api：/voice/speakers 返回按模型类型分组的 JSON
    const speakersProbe = await probe('讲者列表', '/voice/speakers')
    if (speakersProbe.probe.ok) {
        const speakers = parseSpeakersResponse(speakersProbe.response.data)
        if (looksLikeSpeakers(speakersProbe.response.data, speakers)) {
            return {
                ok: true,
                kind: 'vits-simple-api',
                baseUrl,
                probes,
                speakers,
                hint:
                    speakers.length > 0
                        ? undefined
                        : '已识别 vits-simple-api，但讲者列表为空：确认后端已加载模型'
            }
        }
    }

    // 2) OpenAPI：GPT-SoVITS 的 api_v2 / api.py 都是 FastAPI
    const openapi = await probe('OpenAPI', '/openapi.json')
    if (openapi.probe.ok && openapi.response.data) {
        const paths = Object.keys(
            (openapi.response.data as { paths?: Record<string, unknown> })
                .paths ?? {}
        )
        const kind = classifyPaths(paths)
        if (kind !== 'unknown') {
            probes[probes.length - 1].note = `paths: ${paths.slice(0, 6).join(', ')}`
            return {
                ok: true,
                kind,
                baseUrl,
                probes,
                hint: kind === 'vits-simple-api' ? undefined : gptHint(kind)
            }
        }
    }

    // 3) /tts：v2 的 FastAPI 会对缺少参数返回 422
    const ttsProbe = await probe('TTS 端点', '/tts')
    if (
        ttsProbe.probe.status === 422 ||
        ttsProbe.probe.status === 400
    ) {
        return {
            ok: true,
            kind: 'gpt-sovits-v2',
            baseUrl,
            probes,
            hint: gptHint('gpt-sovits-v2')
        }
    }

    // 4) 老版 api.py：根路径就是合成端点
    const rootProbe = await probe('根路径', '/')
    if (
        rootProbe.probe.status === 422 ||
        rootProbe.probe.status === 400 ||
        rootProbe.probe.status === 405
    ) {
        return {
            ok: true,
            kind: 'gpt-sovits-v1',
            baseUrl,
            probes,
            hint: gptHint('gpt-sovits-v1')
        }
    }

    return {
        ok: false,
        kind: 'unknown',
        baseUrl,
        probes,
        hint:
            probes.some((item) => item.status === 401 || item.status === 403)
                ? '探测被拒绝（401/403）：检查用户名/密码、apiKey 或 token'
                : '未能识别后端协议：确认地址可访问、路径没写错，必要时直接用手动后端配置'
    }
}

/** 根据探测结果生成本插件能直接用的后端对象 */
export function buildAutoBackend(
    auto: AutoConfig,
    result: DetectResult
): Backend | undefined {
    if (!result.ok) return undefined

    const label = auto.label?.trim() || '自动'

    if (result.kind === 'vits-simple-api') {
        return {
            type: 'vits-simple-api',
            label,
            enabled: true,
            url: result.baseUrl,
            username: auto.username || undefined,
            password: auto.password || undefined,
            apiKey: auto.apiKey || undefined,
            autoPullSpeaker: true,
            ...(auto.backendTimeout > 0
                ? { timeout: auto.backendTimeout }
                : {}),
            speakers: result.speakers ?? []
        }
    }

    if (result.kind === 'gpt-sovits-v2' || result.kind === 'gpt-sovits-v1') {
        return {
            type: 'GPT-SoVITS2',
            label,
            enabled: true,
            url: result.baseUrl,
            apiVersion: result.kind === 'gpt-sovits-v2' ? 'v2' : 'v1',
            // GPT-SoVITS 没有讲者列表接口，只能等用户补参考音频
            speakers: []
        }
    }

    return undefined
}

function readStatus(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined
    const anyValue = value as any
    return (
        anyValue.status ??
        anyValue.statusCode ??
        anyValue.response?.status ??
        undefined
    )
}

function looksLikeSpeakers(data: unknown, speakers: SpeakerBase[]): boolean {
    if (Array.isArray(data)) return data.length > 0
    if (!data || typeof data !== 'object') return false

    const root = data as Record<string, unknown>
    const keys = Object.keys(root)

    // 标准形状：VITS / BERT-VITS2 / GPT-SOVITS / HUBERT-VITS
    if (keys.some((key) => /VITS|SOVITS/i.test(key))) return true
    if (keys.some((key) => key === 'data' || key === 'speakers')) {
        return speakers.length > 0
    }

    return speakers.length > 0
}

function classifyPaths(paths: string[]): DetectKind {
    if (paths.length === 0) return 'unknown'

    if (
        paths.some((path) => path.startsWith('/voice/vits')) ||
        paths.some((path) => path.startsWith('/voice/speakers'))
    ) {
        return 'vits-simple-api'
    }

    if (
        paths.some((path) => path === '/tts') &&
        paths.some((path) => path.startsWith('/set_gpt_weights'))
    ) {
        return 'gpt-sovits-v2'
    }

    if (
        paths.some((path) => path.startsWith('/change_refer')) ||
        paths.some((path) => path.startsWith('/set_model'))
    ) {
        return 'gpt-sovits-v1'
    }

    if (paths.some((path) => path === '/tts')) return 'gpt-sovits-v2'

    return 'unknown'
}

function gptHint(kind: DetectKind): string {
    return `已识别 GPT-SoVITS ${kind === 'gpt-sovits-v1' ? 'v1（老版 api.py）' : 'v2（api_v2.py）'}；它没有讲者列表，需要在手动后端里为讲者配置 ref_audio_path（参考音频，服务端路径）`
}

