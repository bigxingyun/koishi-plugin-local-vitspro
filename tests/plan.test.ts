import { describe, expect, it } from 'vitest'
import { decidePlan, degradeActionFor } from '../src/core/plan'

describe('decidePlan', () => {
    const options = { minChars: 2, maxChars: 300, maxTextChars: 2000 }

    it('空文本降级', () => {
        expect(decidePlan('tool', 0, true, options)).toEqual({
            action: 'text',
            reason: 'EMPTY_TEXT'
        })
    })

    it('工具路径：低于下限降级', () => {
        expect(decidePlan('tool', 1, false, options)).toEqual({
            action: 'text',
            reason: 'TOO_SHORT'
        })
    })

    it('工具路径：正常范围合成', () => {
        expect(decidePlan('tool', 20, false, options)).toEqual({
            action: 'voice'
        })
    })

    it('工具路径：高于上限降级', () => {
        expect(decidePlan('tool', 301, false, options)).toEqual({
            action: 'text',
            reason: 'TOO_LONG'
        })
    })

    it('指令路径：上限是 maxTextChars', () => {
        expect(decidePlan('command', 2000, false, options)).toEqual({
            action: 'voice'
        })
        expect(decidePlan('command', 2001, false, options)).toEqual({
            action: 'text',
            reason: 'TOO_LONG'
        })
    })

    it('服务路径同样受 maxTextChars 约束', () => {
        expect(decidePlan('service', 500, false, options)).toEqual({
            action: 'voice'
        })
        expect(decidePlan('service', 5000, false, options).reason).toBe(
            'TOO_LONG'
        )
    })
})

describe('degradeActionFor', () => {
    const action = {
        tool: 'error' as const,
        service: 'text' as const,
        command: 'text' as const
    }

    it('工具路径抛错', () => {
        expect(degradeActionFor('tool', action)).toBe('error')
    })

    it('服务路径回文字', () => {
        expect(degradeActionFor('service', action)).toBe('text')
    })

    it('指令路径回文字', () => {
        expect(degradeActionFor('command', action)).toBe('text')
    })
})
