import { Backend } from '../types'

export interface BackendNormalizeResult {
    backends: Backend[]
    /** 无法使用或做过自动修正的说明，给日志与 vitsdebug 用 */
    issues: string[]
}

const TYPE_ALIASES: Record<string, Backend['type']> = {
    'vits-simple-api': 'vits-simple-api',
    vits: 'vits-simple-api',
    'vits_simple_api': 'vits-simple-api',
    'simple-api': 'vits-simple-api',
    'gpt-sovits2': 'GPT-SoVITS2',
    'gpt-sovits': 'GPT-SoVITS2',
    'gpt_sovits': 'GPT-SoVITS2',
    'gpt-sovits-v2': 'GPT-SoVITS2',
    'gpt-sovits-v1': 'GPT-SoVITS2',
    sovits: 'GPT-SoVITS2',
    'gsv-api': 'gsv-api',
    gsv: 'gsv-api',
    'gsv-v1': 'gsv-api',
    'fish-audio': 'fish-audio',
    fish: 'fish-audio',
    'fish_audio': 'fish-audio',
    'qq-voice': 'qq-voice',
    qq: 'qq-voice',
    'qq_voice': 'qq-voice'
}

export function canonicalType(type: unknown): Backend['type'] | undefined {
    if (typeof type !== 'string') return undefined
    return TYPE_ALIASES[type.trim().toLowerCase()]
}

/**
 * 在缺少 `type`（或写错）时，按「只有这种后端才有的字段」反推类型。
 * 推断顺序从最特征化的字段开始，最后才回退到「有 url 就是 vits-simple-api」。
 */
export function inferBackendType(
    item: Record<string, unknown>
): Backend['type'] | undefined {
    const speakers = Array.isArray(item.speakers) ? item.speakers : []
    const firstSpeaker = (speakers[0] ?? {}) as Record<string, unknown>
    const config = (item.config ?? {}) as Record<string, unknown>

    const isGpt =
        item.apiVersion != null ||
        item.gpt_weights != null ||
        item.sovits_weights != null ||
        config.text_split_method != null ||
        config.speech_speed != null ||
        firstSpeaker.gpt_weights != null ||
        firstSpeaker.sovits_weights != null ||
        firstSpeaker.ref_audio_path != null ||
        firstSpeaker.text_lang != null

    if (isGpt) return 'GPT-SoVITS2'

    if (item.accountId != null) return 'qq-voice'
    if (item.baseUrl != null || firstSpeaker.reference_id != null) {
        return 'fish-audio'
    }
    if (item.url != null && /\/v1(\/|$)/.test(String(item.url))) {
        return 'gsv-api'
    }
    if (item.url != null) return 'vits-simple-api'

    return undefined
}

/**
 * 配置层兜底：补齐/纠正 `type`、`enabled`，并剔除无法使用的条目。
 * 返回无法使用的原因，避免再出现「静默 0 个讲者」。
 */
export function normalizeBackends(
    raw: unknown[] | undefined
): BackendNormalizeResult {
    const list = Array.isArray(raw) ? raw : []
    const backends: Backend[] = []
    const issues: string[] = []

    list.forEach((entry, index) => {
        const position = `第 ${index + 1} 个后端`

        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            issues.push(`${position}：不是对象，已跳过`)
            return
        }

        const item = { ...(entry as Record<string, unknown>) }
        const canonical = canonicalType(item.type)
        const inferred = canonical ?? inferBackendType(item)

        if (!inferred) {
            issues.push(
                `${position}：缺少 type 且无法从字段推断（需要 url 或 GPT-SoVITS 的参考音频字段），已跳过`
            )
            return
        }

        if (!canonical) {
            issues.push(
                `${position}：缺少 type，已按字段推断为 ${inferred}` +
                    (item.type != null ? `（原值 ${String(item.type)} 无法识别）` : '')
            )
        }

        item.type = inferred
        if (item.enabled == null) item.enabled = true

        const url = typeof item.url === 'string' ? item.url.trim() : ''

        if (
            inferred === 'vits-simple-api' ||
            inferred === 'GPT-SoVITS2' ||
            inferred === 'gsv-api'
        ) {
            if (!url) {
                issues.push(`${position}（${inferred}）：缺少 url，已跳过`)
                return
            }
            item.url = url
        }

        if (inferred === 'fish-audio') {
            if (!item.apiKey) {
                issues.push(`${position}（fish-audio）：缺少 apiKey，已跳过`)
                return
            }
        }

        if (!Array.isArray(item.speakers)) item.speakers = []

        backends.push(item as unknown as Backend)
    })

    return { backends, issues }
}

