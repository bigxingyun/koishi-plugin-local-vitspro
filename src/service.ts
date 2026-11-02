import { Context, h } from 'koishi'
import * as VitsModule from '@initencounter/vits'
import type {} from '@initencounter/vits'
import { Config } from './config'
import { Pipeline } from './core/pipeline'
import { ElementLike } from './core/element'
import { SynthesizeOptions } from './types'

interface VitsLike {
    say(options: {
        input: string
        speaker_id?: number
        output?: h
    }): Promise<h>
}

type VitsConstructor = new (ctx: Context) => VitsLike

/**
 * `@initencounter/vits` 是 CJS 包（`exports.default`），在 ESM 加载器下
 * default 可能指向模块命名空间，这里逐层取值，保证 `extends` 拿到类。
 */
function resolveVitsClass(mod: any): VitsConstructor {
    const candidates = [mod?.default?.default, mod?.default, mod]
    for (const candidate of candidates) {
        if (typeof candidate === 'function') return candidate as VitsConstructor
    }
    throw new Error('无法解析 @initencounter/vits 的 Vits 类')
}

const VitsBase = resolveVitsClass(VitsModule)

/**
 * 与 chatluna / chatluna-character 的兼容层：
 * 只实现 `@initencounter/vits` 的 `say()`，其它能力通过 `pipeline` 暴露。
 */
export class VitsProService extends VitsBase {
    readonly pipeline: Pipeline
    /** 配置归一化时发现的问题（vitsdebug 会展示） */
    configIssues: string[] = []

    constructor(
        ctx: Context,
        public readonly config: Config
    ) {
        super(ctx)
        this.pipeline = new Pipeline({
            http: (ctx as unknown as { http: any }).http,
            logger: ctx.logger('vitspro'),
            config,
            backends: () => config.backends,
            // 多段补发也必须是真实 Element，否则 satori 会报 Invalid content
            toElement
        })
    }

    async say(options: {
        input: string
        speaker_id?: number
        session?: any
    }): Promise<h> {
        const element = await this.pipeline.say({
            input: options.input,
            speaker_id: options.speaker_id,
            session: options.session
        })
        return toElement(element)
    }

    /** 指令与 chatluna 工具走这里（按讲者名，而不是 speaker_id） */
    async predict(
        text: string,
        options: SynthesizeOptions = {}
    ): Promise<h> {
        const element = await this.pipeline.synthesize(text, options)
        return toElement(element)
    }
}

/**
 * 核心管道返回的是最小元素结构，这里必须用 koishi `h` 重新构造。
 *
 * 直接把 `{ type, attrs, children }` 交给 satori 会抛
 * `TypeError: Invalid content: [object Object]`（chatluna-character 转发时触发）。
 * 上游 luna-vits 的 `predict` 也是直接返回 `h.audio(...)`，这里保持一致。
 */
export function toElement(element: ElementLike): h {
    if (!element || typeof element !== 'object') return h.text('')

    if (element.type === 'text') {
        return h.text(String(element.attrs?.content ?? ''))
    }

    if (element.type === 'audio') {
        const src = String(element.attrs?.src ?? '')
        if (!src) return h.text('')
        return h.audio(src)
    }

    const children = (element.children ?? []).map((child) => toElement(child))
    return h(element.type, { ...(element.attrs ?? {}) }, ...children)
}
