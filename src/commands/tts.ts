import { Context } from 'koishi'
import { VitsProService } from '../service'

/** 与上游一致：管理员（Koishi authority 3） */
const AUTHORITY = 3

export function registerTts(ctx: Context, service: VitsProService): void {
    ctx.command('tts [action:string]', 'TTS 状态与控制', {
        authority: AUTHORITY
    }).action(async (_, action) => {
        const value = (action ?? '').trim().toLowerCase()

        if (!value || value === '状态' || value === 'status') {
            return formatStatus(service)
        }

        if (value === 'on' || value === '开') {
            service.pipeline.setEnabled(true)
            service.pipeline.reset()
            return '语音已开启，熔断与测速状态已清空。'
        }

        if (value === 'off' || value === '关') {
            service.pipeline.setEnabled(false)
            return '语音已关闭，之后只发文字（发 tts on 恢复）。'
        }

        return [
            `未知操作：${action}`,
            '可用：tts / tts on / tts off',
            '　　　tts speakers / tts reload / tts debug <text> / tts reset [后端]'
        ].join('\n')
    })

    ctx.command('tts.speakers', '列出可用讲者', {
        authority: AUTHORITY
    }).action(async () => {
        const voices = await service.pipeline.refreshVoices()
        if (voices.length === 0) {
            return [
                '没有可用讲者：后端可能还没启动，或讲者配置为空。',
                '已开启后台自动重试（5s 起、最多 2 分钟一次），也可以稍后发 tts reload 立即重试。'
            ].join('\n')
        }

        const rows = voices.map(
            (voice) =>
                `[${voice.id}] ${voice.key}（${voice.backend.type}）`
        )
        return [`共 ${voices.length} 个讲者：`, ...rows].join('\n')
    })

    ctx.command('tts.reload', '立即重新拉取讲者列表', {
        authority: AUTHORITY
    }).action(async () => {
        const voices = await service.pipeline.refreshVoices()
        if (voices.length === 0) {
            return '还是没有拉到讲者：确认后端已启动、`url` 与鉴权配置正确。'
        }
        const hint = service.pipeline.needsRefresh()
            ? '（部分后端仍未拉全）'
            : ''
        return `已重新拉取：${voices.length} 个讲者${hint}。`
    })

    ctx.command('tts.debug <text:text>', '查看归一化/切片/决策结果（不发请求）', {
        authority: AUTHORITY
    }).action(async (_, text) => {
        if (!text) return '用法：tts debug <文本>'
        const info = await service.pipeline.explain(text)

        return [
            `原文：${truncate(info.raw)}`,
            `归一化：${truncate(info.text)}`,
            `来源：${info.source} · 可发音字数：${info.chars} · 含序列化标记：${
                info.hadMarkup ? '是' : '否'
            }`,
            `未知标签：${info.unknownTags.length ? info.unknownTags.join(', ') : '无'}`,
            `决策：${info.decision.action}${
                info.decision.reason ? `（${info.decision.reason}）` : ''
            }`,
            `讲者：${info.voice ?? '未解析到'}`,
            `切片：${info.segments.length} 段 → ${info.segments
                .map((segment) => `${segment.length} 字`)
                .join(' / ')}`,
            `超时：${info.timeout} ms`
        ].join('\n')
    })

    ctx.command('tts.reset [backend:string]', '清空测速样本与熔断状态', {
        authority: AUTHORITY
    }).action((_, backend) => {
        service.pipeline.reset(backend)
        return backend
            ? `已清空 ${backend} 的测速样本与熔断状态。`
            : '已清空全部测速样本、熔断状态与提示节流。'
    })
}

export async function formatStatus(service: VitsProService): Promise<string> {
    const enabled = service.pipeline.isEnabled()
    const voices = await service.pipeline.ensureVoices()
    const list = await service.pipeline.status()

    const rows = [
        `TTS 状态：${enabled ? '正常' : '已手动关闭（tts on 恢复）'}`,
        `讲者总数：${voices.length}`
    ]

    if (voices.length === 0) {
        rows.push(
            '讲者列表为空：后端可能还没启动，后台正在自动重试（tts reload 可立即重试）。'
        )
    } else if (service.pipeline.needsRefresh()) {
        rows.push('部分后端的讲者还没拉全，后台正在自动重试（tts reload 可立即重试）。')
    }

    if (list.length === 0) {
        rows.push('没有启用中的后端。')
        return rows.join('\n')
    }

    for (const item of list) {
        const samples =
            item.estimate.samples > 0
                ? `样本 ${item.estimate.samples}`
                : '尚无样本（用默认值）'
        rows.push(
            `· ${item.label}（${item.type}）：讲者 ${item.speakers} · ${item.state}` +
                (item.failures ? `（连续失败 ${item.failures}）` : '') +
                ` · a=${item.estimate.a}ms b=${item.estimate.b}ms/字 · ${samples}` +
                ` · 建议超时(60字) ${formatSeconds(item.suggestedTimeout)}`
        )
    }

    return rows.join('\n')
}

export function formatSeconds(ms: number): string {
    if (!Number.isFinite(ms)) return '∞'
    return `${(ms / 1000).toFixed(1)}s`
}

function truncate(text: string, max = 80): string {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length > max ? `${value.slice(0, max)}…` : value
}

