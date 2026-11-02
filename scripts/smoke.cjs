const assert = require('node:assert/strict')
const { Context } = require('koishi')
const plugin = require('../lib/index.js')

/**
 * 构建产物冒烟测试（CJS）：在真实 koishi Context 里加载插件，
 * 过一遍 schema、指令注册与 vits 服务调用。用 stub http 代替真实 TTS 后端。
 *
 * 说明：koishi 4.18 的 ESM 产物在 Node 24 下加载会失败（loader 的 default
 * 互操作问题），所以这里走 CJS，与 koishi 实际加载插件的方式一致。
 */

let passed = 0

async function check(name, fn) {
    try {
        await fn()
        passed += 1
        console.log(`  ok  ${name}`)
    } catch (error) {
        console.error(`  FAIL ${name}`)
        throw error
    }
}

function silenceWav(seconds = 0.2, sampleRate = 16000) {
    const frames = Math.round(sampleRate * seconds)
    const data = Buffer.alloc(frames * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
}

function createStubHttp() {
    const calls = []
    const handler = async (call) => {
        calls.push(call)
        return silenceWav()
    }
    return {
        calls,
        http: {
            get: (url, config) => handler({ method: 'GET', url, config }),
            post: (url, body, config) =>
                handler({ method: 'POST', url, body, config })
        }
    }
}

const backends = [
    {
        type: 'vits-simple-api',
        label: 'stub',
        url: 'http://127.0.0.1:23456',
        autoPullSpeaker: false,
        speakers: [{ name: '测试', id: 0, type: 'VITS', languages: ['ZH'] }]
    }
]

function tagged(text) {
    return `<output><message quote="123"><voice id="1">${text}</voice></message></output>`
}

async function main() {
    console.log('构建产物冒烟测试（CJS）')

    await check('Config schema 默认值', () => {
        const config = plugin.Config({})
        assert.equal(config.split.mode, 'zh_period')
        assert.equal(config.timeout.mode, 'auto')
        assert.equal(config.breaker.mode, 'auto')
        assert.equal(config.degrade.tool, 'error')
        assert.equal(config.degrade.service, 'text')
        assert.equal(config.bench.ladder.length, 3)
        assert.equal(config.chatlunaTool.name, 'vits_say')
    })

    await check('Config schema 解析后端联合类型', () => {
        const config = plugin.Config({ backends })
        assert.equal(config.backends.length, 1)
        assert.equal(config.backends[0].type, 'vits-simple-api')
        assert.equal(config.backends[0].autoPullSpeaker, false)
        assert.equal(config.backends[0].speakers[0].name, '测试')
    })

    const ctx = new Context()
    const { http, calls } = createStubHttp()
    ctx.set('http', http)

    const config = plugin.Config({ backends })
    ctx.plugin(plugin, config)
    await new Promise((resolve) => setTimeout(resolve, 300))

    await check('注册 vits 服务', () => {
        assert.ok(ctx.vits, 'ctx.vits 未注册')
        assert.equal(typeof ctx.vits.say, 'function')
    })

    await check('注册指令', () => {
        const names = ctx.$commander._commandList.map(
            (command) => command.name
        )
        for (const name of ['vitspro', 'vitsdebug', 'vitsbench']) {
            assert.ok(names.includes(name), `缺少指令 ${name}`)
        }
    })

    await check('say() 解包标签并返回音频元素', async () => {
        const text = '今天天气不错，我们出去走走吧。'
        const element = await ctx.vits.say({
            input: tagged(text),
            speaker_id: 0,
            session: { send: async () => undefined }
        })

        assert.equal(element.type, 'audio')
        assert.match(String(element.attrs.src), /^data:.*;base64,/)
        assert.ok(calls.length > 0)

        const sent = String(calls[calls.length - 1].body.get('text'))
        assert.equal(sent, text)
        assert.ok(!sent.includes('<'))
    })

    await check('工具路径太短抛 VitsDegradeError', async () => {
        await assert.rejects(
            ctx.vits.say({ input: tagged('嗯'), session: {} }),
            (error) =>
                error.name === 'VitsDegradeError' && error.code === 'TOO_SHORT'
        )
    })

    await check('服务路径降级为文字而不是抛错', async () => {
        const long = '测'.repeat(2100)
        const element = await ctx.vits.say({
            input: long,
            speaker_id: 0,
            session: { send: async () => undefined }
        })
        assert.equal(element.type, 'text')
        assert.equal(element.attrs.content.length, 2100)
    })

    await check('关闭语音后返回文字', async () => {
        ctx.vits.pipeline.setEnabled(false)
        const element = await ctx.vits.say({
            input: '你好。',
            speaker_id: 0,
            session: { send: async () => undefined }
        })
        assert.equal(element.type, 'text')
        ctx.vits.pipeline.setEnabled(true)
    })

    await check('vitsbench 长度阶梯产出报告', async () => {
        const reports = await ctx.vits.pipeline.bench('stub', undefined, 1)
        assert.equal(reports.length, 1)
        assert.deepEqual(
            reports[0].points.map((point) => point.chars),
            [6, 12, 24]
        )
        assert.ok(reports[0].points.every((point) => point.samples === 1))
        assert.ok(reports[0].suggestedTimeout > 0)
    })

    await check('状态输出包含后端信息', async () => {
        const status = await ctx.vits.pipeline.status()
        assert.equal(status.length, 1)
        assert.equal(status[0].speakers, 1)
        assert.match(status[0].state, /closed|half-open|open/)
    })

    await check('后端晚于 Koishi 启动：讲者列表能补拉', async () => {
        const late = new Context()
        let online = false
        const speakerCalls = []

        late.set('http', {
            get: async (url) => {
                if (!url.endsWith('/voice/speakers')) return {}
                speakerCalls.push(url)
                if (!online) {
                    const error = new Error('connect refused')
                    error.code = 'ECONNREFUSED'
                    throw error
                }
                return { VITS: [{ name: '派蒙', id: 0, lang: ['zh'] }] }
            },
            post: async () => silenceWav()
        })

        late.plugin(
            plugin,
            plugin.Config({
                backends: [
                    {
                        type: 'vits-simple-api',
                        label: 'late',
                        url: 'http://127.0.0.1:1',
                        autoPullSpeaker: true,
                        speakers: []
                    }
                ]
            })
        )

        await new Promise((resolve) => setTimeout(resolve, 300))

        assert.equal(
            late.vits.pipeline.needsRefresh(),
            true,
            '空讲者列表必须标记为待重试'
        )
        assert.equal(late.vits.pipeline.getVoices().length, 0)

        online = true
        const voices = await late.vits.pipeline.refreshVoices()

        assert.equal(voices.length, 1)
        assert.equal(voices[0].key, 'late/派蒙_ZH')
        assert.equal(late.vits.pipeline.needsRefresh(), false)
        assert.ok(speakerCalls.length >= 1)
    })

    await check('vitsdebug probe 返回诊断信息', async () => {
        const probes = await ctx.vits.pipeline.probe()
        assert.equal(probes.length, 1)
        // 该后端 autoPullSpeaker=false，不应发请求
        assert.equal(probes[0].requested, false)
        assert.equal(probes[0].count, 1)
        assert.match(probes[0].hint, /autoPullSpeaker/)
    })

    await check('GPT-SoVITS 后端走 /tts 并返回音频', async () => {
        const gsv = new Context()
        const gsvCalls = []

        gsv.set('http', {
            get: async (url) => {
                gsvCalls.push({ method: 'GET', url })
                return { message: 'success' }
            },
            post: async (url, body) => {
                gsvCalls.push({ method: 'POST', url, body })
                return silenceWav()
            }
        })

        gsv.plugin(
            plugin,
            plugin.Config({
                backends: [
                    {
                        type: 'GPT-SoVITS2',
                        label: 'gsv',
                        url: 'http://127.0.0.1:9880',
                        speakers: [
                            {
                                name: '丛雨',
                                ref_audio_path: 'audio/ref.ogg',
                                prompt_text: 'ほれ',
                                prompt_lang: 'ja',
                                text_lang: 'zh'
                            }
                        ]
                    }
                ]
            })
        )

        await new Promise((resolve) => setTimeout(resolve, 300))

        const element = await gsv.vits.say({
            input: '你好。',
            session: { send: async () => undefined }
        })

        assert.equal(element.type, 'audio')

        const post = gsvCalls.find((call) => call.method === 'POST')
        assert.ok(post, '没有发出 POST /tts')
        assert.equal(post.url, 'http://127.0.0.1:9880/tts')
        assert.equal(post.body.ref_audio_path, 'audio/ref.ogg')
        assert.equal(post.body.prompt_lang, 'ja')
        assert.equal(post.body.text_lang, 'zh')
        assert.equal(post.body.streaming_mode, false)
        assert.equal(post.body.media_type, 'wav')
    })

    console.log(`\n全部通过：${passed} 项`)
    if (typeof ctx.scope?.dispose === 'function') ctx.scope.dispose()
    process.exit(0)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})

