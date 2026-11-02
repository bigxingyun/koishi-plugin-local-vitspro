import { Context } from 'koishi'
import { Config } from '../config'
import { VitsProService } from '../service'
import { VitsDegradeError } from '../core/errors'

/**
 * 可选注册 chatluna 工具 `vits_say`：让模型可以主动把某句话变成语音。
 *
 * 依赖（`koishi-plugin-chatluna` / `@langchain/core` / `zod`）全部是可选 peer，
 * 并且用动态 import 加载——没装 chatluna 的实例不会受影响。
 */
export function registerChatlunaTool(
    ctx: Context,
    config: Config,
    service: VitsProService
): void {
    if (!config.chatlunaTool.enabled) return

    // 不能只看此刻有没有 chatluna：插件加载顺序不保证 chatluna 在前。
    // 用 inject 等 chatluna 服务就绪后再注册，否则会静默漏注册。
    ctx.inject(['chatluna'], (ctx) => {
        register(ctx, config, service)
    })
}

function register(
    ctx: Context,
    config: Config,
    service: VitsProService
): void {
    const logger = ctx.logger('vitspro')

    void (async () => {
        try {
            const { tool } = await dynamicImport('@langchain/core/tools')
            const { z } = await dynamicImport('zod')
            const chat = await dynamicImport('koishi-plugin-chatluna/services/chat')
            const { ChatLunaPlugin } = chat

            const name = config.chatlunaTool.name
            const plugin = new ChatLunaPlugin(
                ctx as never,
                {} as never,
                'local-vitspro' as never,
                false
            )

            const toolInstance = tool(
                async (input: any, runConfig: any) => {
                    const session = runConfig?.configurable?.session
                    try {
                        const element = await service.predict(
                            String(input?.text ?? ''),
                            {
                                speaker: input?.speaker,
                                session,
                                source: 'tool'
                            }
                        )

                        if (config.chatlunaTool.sendAudio && session?.send) {
                            await session.send(element)
                        }

                        return `已用语音回复（${String(input?.text ?? '').length} 字）`
                    } catch (error) {
                        const reason =
                            error instanceof VitsDegradeError
                                ? error.code
                                : 'ERROR'
                        return `语音合成未执行：${reason}`
                    }
                },
                {
                    name,
                    description:
                        '把一段文本用 TTS 合成语音并发送到当前会话。只在需要“说出来”时调用。',
                    schema: z.object({
                        text: z
                            .string()
                            .describe('要朗读的纯文本，不要带任何标签'),
                        speaker: z
                            .string()
                            .optional()
                            .describe('讲者名（可选，默认讲者）')
                    })
                }
            )

            plugin.registerTool(toolInstance.name, {
                description: toolInstance.description,
                selector: () => true,
                createTool: () => toolInstance,
                authorization: (session: any) =>
                    (session?.user?.authority ?? 1) >=
                    config.chatlunaTool.authority,
                meta: {
                    source: 'extension',
                    group: 'local-vitspro',
                    tags: ['tts', 'voice'],
                    defaultAvailability: {
                        enabled: true,
                        main: true,
                        chatluna: true,
                        characterScope: 'all'
                    }
                }
            })

            logger.info(`已注册 chatluna 工具 ${name}`)
        } catch (error) {
            logger.warn(
                `注册 chatluna 工具失败（不影响 TTS 功能）：${
                    (error as Error)?.message ?? error
                }`
            )
        }
    })()
}

/** 变量说明符的动态 import：没装包时只有运行时失败，不阻塞构建 */
function dynamicImport(name: string): Promise<any> {
    return import(name) as Promise<any>
}
