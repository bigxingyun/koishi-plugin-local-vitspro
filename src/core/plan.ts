import { DegradeCode, Source } from '../types'

export interface PlanOptions {
    /** 工具路径：低于该字数不合成 */
    minChars: number
    /** 工具路径：高于该字数不合成 */
    maxChars: number
    /** 服务/指令路径的字数上限 */
    maxTextChars: number
}

export type PlanAction = 'voice' | 'text'

export interface PlanDecision {
    action: PlanAction
    reason?: DegradeCode
}

/**
 * 唯一决策点：这次到底发语音还是发文字。
 *
 * - 空文本 → EMPTY_TEXT
 * - 工具路径（chatluna-character）→ 低于 minChars / 高于 maxChars 都降级
 * - 服务 / 指令路径 → 超过 maxTextChars 才降级
 */
export function decidePlan(
    source: Source,
    chars: number,
    empty: boolean,
    options: PlanOptions
): PlanDecision {
    if (empty) return { action: 'text', reason: 'EMPTY_TEXT' }

    if (source === 'tool') {
        if (chars < options.minChars) {
            return { action: 'text', reason: 'TOO_SHORT' }
        }
        if (chars > options.maxChars) {
            return { action: 'text', reason: 'TOO_LONG' }
        }
        return { action: 'voice' }
    }

    if (chars > options.maxTextChars) {
        return { action: 'text', reason: 'TOO_LONG' }
    }

    return { action: 'voice' }
}

/** 按来源决定「降级时抛错还是回文字」 */
export function degradeActionFor(
    source: Source,
    action: { tool: 'error' | 'text'; service: 'error' | 'text'; command: 'error' | 'text' }
): 'error' | 'text' {
    switch (source) {
        case 'tool':
            return action.tool
        case 'service':
            return action.service
        default:
            return action.command
    }
}

