import { Context } from 'koishi'
import { VitsProService } from '../service'
import { VitsDegradeError } from '../core/errors'

export function registerVitspro(ctx: Context, service: VitsProService): void {
    // 不注册任何别名：旧插件的 `lunavits` / 其它插件的 `tts` 都可能与之冲突
    ctx.command('vitspro <text:text>', '用 TTS 合成一段语音')
        .option('speaker', '-s <speaker:string> 讲者名或讲者 id')
        .action(async ({ session, options }, text) => {
            if (!text || !text.trim()) return '请输入要合成的文本。'

            const speaker = options?.speaker?.trim()
            const speakerId =
                speaker && /^\d+$/.test(speaker) ? Number(speaker) : undefined

            try {
                if (speakerId != null) {
                    const element = await service.pipeline.say({
                        input: text,
                        speaker_id: speakerId,
                        session,
                        source: 'command'
                    })
                    return element as any
                }

                return (await service.predict(text, {
                    speaker: speaker || undefined,
                    session,
                    source: 'command'
                })) as any
            } catch (error) {
                if (error instanceof VitsDegradeError) {
                    return `未合成（${error.code}）。`
                }
                return `合成失败：${(error as Error)?.message ?? error}`
            }
        })
}

