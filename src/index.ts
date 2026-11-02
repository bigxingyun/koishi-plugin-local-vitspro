import { Context } from 'koishi'
import { readFileSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { Config, name } from './config'
import { VitsProService } from './service'
import { Backend } from './types'
import { parseBackendsYaml } from './core/backends-file'
import { registerCommands } from './commands'
import { registerChatlunaTool } from './chatluna/tool'

export { Config, name }
export * from './types'
export { VitsProService } from './service'
export { Pipeline } from './core/pipeline'
export { VitsDegradeError, BackendError } from './core/errors'

export const inject = {
    required: ['http'],
    optional: ['translator', 'chatluna']
}

export function apply(ctx: Context, config: Config): void {
    applyFileMode(ctx, config)

    ctx.plugin(VitsProService, config)

    ctx.inject(['vits'], (ctx) => {
        const service = ctx.vits as unknown as VitsProService
        const logger = ctx.logger('vitspro')

        ctx.on('ready', () => {
            void service.pipeline
                .ensureVoices(true)
                .then(() => {
                    logger.info(
                        `已加载 ${service.pipeline.getVoices().length} 个讲者`
                    )
                })
                .catch((error) => {
                    logger.warn(`加载讲者失败：${(error as Error)?.message ?? error}`)
                })
        })

        registerCommands(ctx, config, service)
        registerChatlunaTool(ctx, config, service)
    })
}

/**
 * 文件模式：读一份 YAML 后端列表（默认 data/local-vitspro/config.yml）。
 * 只认自己的路径，不读旧插件的 data/local-vits/，也不做任何迁移。
 */
function applyFileMode(ctx: Context, config: Config): void {
    if (config.backendsSource !== 'file') return

    const logger = ctx.logger('vitspro')
    const filePath = resolve(ctx.baseDir ?? process.cwd(), config.backendsFile)

    const read = (): Backend[] | null => {
        try {
            return parseBackendsYaml(readFileSync(filePath, 'utf8'))
        } catch (error) {
            logger.warn(
                `读取 ${filePath} 失败（继续使用控制台配置）：${
                    (error as Error)?.message ?? error
                }`
            )
            return null
        }
    }

    const initial = read()
    if (initial) config.backends = initial

    try {
        const watcher = watch(filePath, () => {
            const reload = ctx.setTimeout(() => {
                const next = read()
                if (!next) return
                config.backends = next
                logger.info(`后端配置已热更新（${next.length} 个）`)
                const service = (ctx as unknown as { vits?: VitsProService }).vits
                void service?.pipeline.ensureVoices(true)
            }, 300)
            void reload
        })

        ctx.effect(() => () => watcher.close())
    } catch (error) {
        logger.warn(
            `无法监听 ${filePath}（改为仅启动时读取）：${
                (error as Error)?.message ?? error
            }`
        )
    }
}


