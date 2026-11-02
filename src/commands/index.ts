import { Context } from 'koishi'
import { Config } from '../config'
import { VitsProService } from '../service'
import { registerVitspro } from './vitspro'
import { registerDebug } from './debug'
import { registerBench } from './bench'

export function registerCommands(
    ctx: Context,
    config: Config,
    service: VitsProService
): void {
    registerVitspro(ctx, service)
    registerDebug(ctx, service)
    registerBench(ctx, config, service)
}
