import { load } from 'js-yaml'
import { Backend } from '../types'

/**
 * 解析文件模式的后端列表（YAML 数组）。
 * 只做结构校验，不做 Schema 解析——字段由后端适配器按需读取。
 */
export function parseBackendsYaml(text: string): Backend[] {
    const parsed = load(text)
    if (!Array.isArray(parsed)) {
        throw new Error('后端配置必须是一个数组')
    }
    for (const [index, item] of parsed.entries()) {
        if (item == null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 项不是对象`)
        }
        if (typeof (item as Backend).type !== 'string') {
            throw new Error(`第 ${index + 1} 项缺少 type`)
        }
    }
    return parsed as Backend[]
}
