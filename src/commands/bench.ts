import { Context } from 'koishi'
import { Config } from '../config'
import { VitsProService } from '../service'
import { formatSeconds } from './tts'

/** 与上游 `tts` 指令一致的管理员权限 */
const AUTHORITY = 3

export function registerBench(
    ctx: Context,
    config: Config,
    service: VitsProService
): void {
    if (!config.bench.enabled) return

    ctx.command(
        'vitsbench [backend:string]',
        '基准测速：测量后端推理速度并写回超时模型',
        { authority: AUTHORITY }
    )
        .option('repeat', '-n <n:number> 每档重复次数')
        .option('speaker', '-s <speaker:string> 指定讲者')
        .option('reset', '-r 先清空该后端样本')
        .option('force', '-f 先清空熔断状态')
        .action(async ({ options }, backend) => {
            if (options?.reset) service.pipeline.reset(backend ?? undefined)
            if (options?.force) {
                service.pipeline.reset(backend ?? undefined)
            }

            const repeat =
                options?.repeat != null ? Number(options.repeat) : undefined
            if (repeat != null && (!Number.isFinite(repeat) || repeat < 1)) {
                return '重复次数必须是正整数。'
            }

            const reports = await service.pipeline.bench(
                backend ?? undefined,
                options?.speaker ?? undefined,
                repeat
            )

            if (reports.length === 0) {
                return '没有匹配的后端（检查 label 或后端是否已启用）。'
            }

            const rows = [
                `基准测试：${reports.length} 个后端，每档 ${
                    repeat ?? config.bench.repeat
                } 次取中位`
            ]

            for (const report of reports) {
                if (report.skipped) {
                    rows.push(`· ${report.label}：跳过（${report.skipped}）`)
                    continue
                }

                rows.push(`· ${report.label}`)
                for (const point of report.points) {
                    const value =
                        point.samples > 0
                            ? formatSeconds(point.medianMs)
                            : '全部失败'
                    const failed = point.failed
                        ? `，失败 ${point.failed} 次`
                        : ''
                    rows.push(
                        `　${point.chars} 字：${value}（成功 ${point.samples} 次${failed}）`
                    )
                }
                rows.push(
                    `　拟合：a=${report.a}ms b=${report.b}ms/字 · 样本 ${report.samples}` +
                        ` · 建议超时(60字) ${formatSeconds(report.suggestedTimeout)} · ${report.state}`
                )
            }

            return rows.join('\n')
        })
}
