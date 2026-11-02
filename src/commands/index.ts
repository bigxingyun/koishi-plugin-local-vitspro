import { Context } from 'koishi'
import { Config } from '../config'
import { VitsProService } from '../service'
import { registerVitspro } from './vitspro'
import { registerTts } from './tts'
import { registerBench } from './bench'

export function registerCommands(
    ctx: Context,
    config: Config,
    service: VitsProService
): void {
    registerVitspro(ctx, service)
    registerTts(ctx, service)
    registerBench(ctx, config, service)
}
