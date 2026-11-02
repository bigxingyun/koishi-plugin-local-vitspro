/**
 * 最小元素工厂：与 koishi `h` 产出的结构一致（type / attrs / children）。
 *
 * 核心管道不直接依赖 koishi，好处是单测可以在纯 Node 环境跑；
 * 插件层（service.ts）再把结果交给真正的 `h()` 规整。
 */
export interface ElementLike {
    type: string
    attrs: Record<string, any>
    children?: ElementLike[]
}

export function audioElement(data: Buffer, format = 'wav'): ElementLike {
    return {
        type: 'audio',
        attrs: { src: `data:${format};base64,${data.toString('base64')}` },
        children: []
    }
}

export function textElement(content: string): ElementLike {
    return { type: 'text', attrs: { content }, children: [] }
}
