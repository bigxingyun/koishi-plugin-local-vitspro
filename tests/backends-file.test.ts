import { describe, expect, it } from 'vitest'
import { parseBackendsYaml } from '../src/core/backends-file'

describe('parseBackendsYaml', () => {
    it('解析 YAML 数组', () => {
        const list = parseBackendsYaml(`
- type: vits-simple-api
  label: 本地
  url: http://127.0.0.1:23456
  speakers:
    - name: 测试
      id: 0
      type: VITS
      languages: [ZH]
- type: fish-audio
  apiKey: key
`)

        expect(list).toHaveLength(2)
        expect(list[0].type).toBe('vits-simple-api')
        expect((list[0] as any).speakers[0].name).toBe('测试')
        expect(list[1].type).toBe('fish-audio')
    })

    it('不是数组时报错', () => {
        expect(() => parseBackendsYaml('type: vits-simple-api')).toThrow(
            '必须是一个数组'
        )
    })

    it('条目不是对象时报错', () => {
        expect(() => parseBackendsYaml('- 123')).toThrow('不是对象')
    })

    it('缺少 type 时报错', () => {
        expect(() => parseBackendsYaml('- url: http://x')).toThrow('缺少 type')
    })
})
