import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 防泄漏守卫：仓库里不允许出现真实的公网 IP、npm token、私钥。
 * 允许 127.0.0.1 / 0.0.0.0 / 私网段与示例域名。
 */

const ROOT = join(__dirname, '..')
const SKIP_DIRS = new Set([
    'node_modules',
    'lib',
    'dist',
    '.git',
    'coverage',
    'data'
])

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.tgz'])

const HEALTHY_IP = /^(?:127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const stat = statSync(full)
        if (stat.isDirectory()) {
            if (SKIP_DIRS.has(name)) continue
            walk(full, out)
            continue
        }
        const dot = name.lastIndexOf('.')
        const ext = dot === -1 ? '' : name.slice(dot).toLowerCase()
        if (SKIP_EXT.has(ext)) continue
        out.push(full)
    }
    return out
}

function scan(pattern: RegExp, allow?: (match: string) => boolean) {
    const hits: string[] = []

    for (const file of walk(ROOT)) {
        let text: string
        try {
            text = readFileSync(file, 'utf8')
        } catch {
            continue
        }
        const lines = text.split(/\r?\n/)
        lines.forEach((line, index) => {
            const matches = line.match(pattern)
            if (!matches) return
            if (allow && matches.every((item) => allow(item))) return
            hits.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
        })
    }

    return hits
}

describe('仓库不含敏感信息', () => {
    it('没有公网 IP（示例只能用 127.0.0.1 或私网地址）', () => {
        const hits = scan(/\b\d{1,3}(?:\.\d{1,3}){3}\b/, (ip) =>
            HEALTHY_IP.test(ip)
        )
        expect(hits, `发现公网 IP：\n${hits.join('\n')}`).toEqual([])
    })

    it('没有 npm token / 私钥 / 常见密钥前缀', () => {
        const hits = [
            ...scan(/\bnpm_[A-Za-z0-9]{20,}\b/),
            ...scan(/-----BEGIN [A-Z ]*PRIVATE KEY-----/),
            ...scan(/\b(?:sk|ghp|xoxb)-[A-Za-z0-9]{20,}\b/)
        ]
        expect(hits, `发现凭据：\n${hits.join('\n')}`).toEqual([])
    })
})
