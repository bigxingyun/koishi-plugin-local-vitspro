import { Context } from 'koishi'
import { VitsProService } from '../service'

/** 与上游 `tts` 指令一致的管理员权限 */
const AUTHORITY = 3

const HELP = [
    'vitsdebug 用法：',
    '  vitsdebug                 查看状态',
    '  vitsdebug on | off        开启（清熔断）/ 临时关闭语音',
    '  vitsdebug speakers        讲者列表（强制重新拉取）',
    '  vitsdebug reload          立即重新拉取讲者',
    '  vitsdebug probe [后端]    诊断讲者拉取（URL / 状态码 / 错误）',
    '  vitsdebug text <文本>     查看归一化、切片、决策与超时（不发请求）',
    '  vitsdebug reset [后端]    清空测速样本与熔断状态'
].join('\n')

export function registerDebug(ctx: Context, service: VitsProService): void {
    ctx.command(
        'vitsdebug [action:string] [arg:text]',
        'TTS 调试与状态：状态 / 开关 / 讲者 / probe / 决策 / 重置',
        { authority: AUTHORITY }
    ).action(async (_, action, arg) => {
        const value = (action ?? '').trim().toLowerCase()

        if (!value || value === 'status' || value === '状态') {
            return formatStatus(service)
        }

        if (value === 'on' || value === '开') {
            service.pipeline.setEnabled(true)
            service.pipeline.reset()
            return '语音已开启，熔断与测速状态已清空。'
        }

        if (value === 'off' || value === '关') {
            service.pipeline.setEnabled(false)
            return '语音已关闭，之后只发文字（vitsdebug on 恢复）。'
        }

        if (value === 'speakers') {
            const voices = await service.pipeline.refreshVoices()
            if (voices.length === 0) {
                return service.pipeline.needsRefresh()
                    ? '没有可用讲者：后端可能还没启动，后台正在自动重试；发 vitsdebug probe 可看具体原因。'
                    : '没有配置任何讲者：后端未启用自动拉取（autoPullSpeaker=false），或 speakers 为空。'
            }

            const rows = voices.map(
                (voice) => `[${voice.id}] ${voice.key}（${voice.backend.type}）`
            )
            return [`共 ${voices.length} 个讲者：`, ...rows].join('\n')
        }

        if (value === 'reload') {
            const voices = await service.pipeline.refreshVoices()
            if (voices.length === 0) {
                return service.pipeline.needsRefresh()
                    ? '还是没有拉到讲者：发 vitsdebug probe 看具体 URL / 状态码 / 错误。'
                    : '没有配置任何讲者：后端未启用自动拉取，或 speakers 为空。'
            }
            const hint = service.pipeline.needsRefresh()
                ? '（部分后端仍未拉全，可发 vitsdebug probe 看原因）'
                : ''
            return `已重新拉取：${voices.length} 个讲者${hint}。`
        }

        if (value === 'probe') {
            return formatProbe(await service.pipeline.probe(arg?.trim() || undefined))
        }

        if (value === 'text' || value === 'debug') {
            if (!arg || !arg.trim()) return '用法：vitsdebug text <文本>'
            return formatExplain(service, arg)
        }

        if (value === 'reset') {
            service.pipeline.reset(arg?.trim() || undefined)
            return arg?.trim()
                ? `已清空 ${arg.trim()} 的测速样本与熔断状态。`
                : '已清空全部测速样本、熔断状态与提示节流。'
        }

        if (value === 'help' || value === '?' || value === '帮助') {
            return HELP
        }

        return `未知操作：${action}\n\n${HELP}`
    })
}

export async function formatStatus(
    service: VitsProService
): Promise<string> {
    const enabled = service.pipeline.isEnabled()
    const voices = await service.pipeline.ensureVoices()
    const list = await service.pipeline.status()

    const rows = [
        `TTS 状态：${enabled ? '正常' : '已手动关闭（vitsdebug on 恢复）'}`,
        `讲者总数：${voices.length}`
    ]

    if (voices.length === 0) {
        rows.push(
            service.pipeline.needsRefresh()
                ? '讲者列表为空：后端可能还没启动，后台正在自动重试（vitsdebug probe 看原因 / vitsdebug reload 立即重试）。'
                : '没有配置任何讲者：后端未启用自动拉取，或 speakers 为空。'
        )
    } else if (service.pipeline.needsRefresh()) {
        rows.push(
            '部分后端的讲者还没拉全，后台正在自动重试（vitsdebug probe 看原因）。'
        )
    }

    if (list.length === 0) {
        rows.push('没有启用中的后端。')
        return rows.join('\n')
    }

    for (const item of list) {
        const samples =
            item.estimate.samples > 0
                ? `样本 ${item.estimate.samples}`
                : '尚无样本（用冷启动超时）'
        rows.push(
            `· ${item.label}（${item.type}）：讲者 ${item.speakers} · ${item.state}` +
                (item.failures ? `（连续失败 ${item.failures}）` : '') +
                ` · a=${item.estimate.a}ms b=${item.estimate.b}ms/字 · ${samples}` +
                ` · 建议超时(60字) ${formatSeconds(item.suggestedTimeout)}`
        )
    }

    return rows.join('\n')
}

async function formatProbe(
    probes: Awaited<ReturnType<VitsProService['pipeline']['probe']>>
): Promise<string> {
    if (probes.length === 0) {
        return '没有匹配的后端（检查 label 或后端是否已启用）。'
    }

    const rows = [`讲者探测（${probes.length} 个后端）`]

    for (const probe of probes) {
        rows.push(`· ${probe.label}（${probe.type}）`)

        if (!probe.requested) {
            rows.push(
                `  未请求：autoPullSpeaker=false · 配置讲者 ${probe.count} 个`
            )
            if (probe.hint) rows.push(`  提示：${probe.hint}`)
            continue
        }

        if (probe.url) rows.push(`  URL：${probe.url}`)

        if (probe.ok) {
            const sample = probe.sample?.length
                ? `：${probe.sample.join('、')}`
                : ''
            rows.push(
                `  成功 · ${probe.status ?? 200} · ${probe.ms}ms · 讲者 ${probe.count} 个${sample}`
            )
        } else {
            rows.push(`  失败 · ${probe.ms}ms`)
            if (probe.error) rows.push(`  错误：${truncate(probe.error, 200)}`)
        }

        if (probe.hint) rows.push(`  提示：${probe.hint}`)
    }

    return rows.join('\n')
}

async function formatExplain(
    service: VitsProService,
    text: string
): Promise<string> {
    const info = await service.pipeline.explain(text)

    return [
        `原文：${truncate(info.raw)}`,
        `归一化：${truncate(info.text)}`,
        `来源：${info.source} · 可发音字数：${info.chars} · 含序列化标记：${
            info.hadMarkup ? '是' : '否'
        }`,
        `未知标签：${
            info.unknownTags.length ? info.unknownTags.join(', ') : '无'
        }`,
        `决策：${info.decision.action}${
            info.decision.reason ? `（${info.decision.reason}）` : ''
        }`,
        `讲者：${info.voice ?? '未解析到'}`,
        `切片：${info.segments.length} 段 → ${info.segments
            .map((segment) => `${segment.length} 字`)
            .join(' / ')}`,
        `超时：${info.timeout} ms`
    ].join('\n')
}

export function formatSeconds(ms: number): string {
    if (!Number.isFinite(ms)) return '∞'
    return `${(ms / 1000).toFixed(1)}s`
}

function truncate(text: string, max = 80): string {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length > max ? `${value.slice(0, max)}…` : value
}
