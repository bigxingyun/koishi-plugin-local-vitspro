import { ElementLike, audioElement, textElement } from './element'
import {
    AudioResult,
    Backend,
    DegradeCode,
    HttpClient,
    LoggerLike,
    SayOptions,
    Source,
    SpeakerBase,
    SynthesizeOptions,
    VoiceEntry
} from '../types'
import { Config } from '../config'
import { VitsDegradeError, classifyError } from './errors'
import {
    NormalizeResult,
    detectMarkup,
    isEffectivelyEmpty,
    normalize
} from './normalize'
import { speakableLength } from './length'
import { SplitOptions, splitText } from './split'
import { mergeWavs } from './merge'
import { Estimator } from './estimator'
import { Breaker } from './breaker'
import { NoticeThrottle } from './notice'
import { decidePlan, degradeActionFor } from './plan'
import { mapWithConcurrency, withTimeout } from './scheduler'
import { AdapterMap, createAdapters } from '../adapters'
import { SpeakerProbe } from '../adapters/base'
import { DetectResult, buildAutoBackend, detectBackend } from './detect'
import { shortFormat } from '../adapters/base'

export interface PipelineDeps {
    http: HttpClient
    logger: LoggerLike
    config: Config
    backends: () => Backend[]
    now?: () => number
}

export interface BackendStatus {
    label: string
    type: Backend['type']
    speakers: number
    state: string
    failures: number
    estimate: { a: number; b: number; samples: number; source: string }
    suggestedTimeout: number
}

export interface BenchPoint {
    chars: number
    medianMs: number
    samples: number
    failed: number
}

export interface BenchReport {
    label: string
    points: BenchPoint[]
    a: number
    b: number
    suggestedTimeout: number
    samples: number
    state: string
    skipped?: string
}

/** 每字约 0.18s 的粗略时长估算，只用于平台时长上限保护 */
const SECONDS_PER_CHAR = 0.18

const NOTICE_REASON: Record<DegradeCode, string> = {
    EMPTY_TEXT: '没有可朗读的内容',
    TOO_SHORT: '文本太短',
    TOO_LONG: '文本超出语音长度上限',
    CIRCUIT_OPEN: '语音服务暂时不可用',
    DISABLED: '语音已被管理员关闭',
    TIMEOUT: '语音合成超时',
    BACKEND_ERROR: '语音服务返回错误',
    NO_SPEAKER: '没有可用的讲者',
    ALL_SEGMENTS_FAILED: '语音合成失败'
}

export class Pipeline {
    readonly estimator: Estimator
    readonly breaker: Breaker
    readonly notice: NoticeThrottle
    private readonly adapters: AdapterMap
    private readonly logger: LoggerLike
    private readonly now: () => number
    private voices: VoiceEntry[] = []
    private voicesLoaded = false
    /** 有后端没拉全（后端还没启动 / 拉取失败）→ 需要后台重试 */
    private voicesStale = false
    private lastLoadAt = 0
    private loading?: Promise<void>
    private enabled = true
    /** 自动配置探测出来的后端与结果（`vitsdebug` 会展示） */
    private autoBackend?: Backend
    private autoResult?: DetectResult
    private autoAt = 0
    /** 两次拉取讲者之间的最小间隔，避免后端不可用时每个请求都去撞 */
    private readonly voicesRetryInterval = 5000
    /** 讲者列表的过期时间：到点后自动刷新，能感知后端新增讲者 */
    private readonly voicesTtl = 60000

    constructor(private readonly deps: PipelineDeps) {
        this.logger = deps.logger
        this.now = deps.now ?? (() => Date.now())
        this.estimator = new Estimator(32, this.now)
        this.breaker = new Breaker({ ...deps.config.breaker, now: this.now })
        this.notice = new NoticeThrottle(
            { ...deps.config.notice },
            this.now
        )
        this.adapters = createAdapters({
            http: deps.http,
            logger: deps.logger
        })
    }

    // -----------------------------------------------------------------------
    // 讲者
    // -----------------------------------------------------------------------

    async ensureVoices(force = false): Promise<VoiceEntry[]> {
        if (this.loading) {
            await this.loading
            return this.voices
        }

        const now = this.now()
        const withinCooldown =
            this.voicesLoaded && now - this.lastLoadAt < this.voicesRetryInterval
        const mustRefresh =
            !this.voicesLoaded ||
            this.voicesStale ||
            now - this.lastLoadAt > this.voicesTtl

        // 冷却期内一律用缓存：后端不可用时不会每个请求都去撞
        if (withinCooldown) return this.voices
        if (!mustRefresh && !force) return this.voices

        this.loading = this.loadVoices()
        try {
            await this.loading
        } finally {
            this.loading = undefined
        }
        return this.voices
    }

    /** 讲者列表是否还没拉全（给后台重试与状态提示用） */
    needsRefresh(): boolean {
        return !this.voicesLoaded || this.voicesStale
    }

    /**
     * 用户显式触发的刷新（`tts reload` / `tts speakers` / 后台重试循环）：
     * 跳过 5s 冷却，立即重新拉取。
     */
    async refreshVoices(): Promise<VoiceEntry[]> {
        if (this.loading) {
            await this.loading
            return this.voices
        }

        this.loading = this.loadVoices()
        try {
            await this.loading
        } finally {
            this.loading = undefined
        }
        return this.voices
    }

    getVoices(): VoiceEntry[] {
        return this.voices
    }

    /**
     * 自动配置：探测一次并缓存（TTL 与讲者列表一致）。
     * 只在开启了 `auto.enabled` 且有 url 时生效；失败不抛。
     */
    private async ensureAuto(): Promise<void> {
        const auto = this.deps.config.auto
        if (!auto || !auto.enabled || !String(auto.url ?? '').trim()) return
        if (this.autoAt > 0 && this.now() - this.autoAt < this.voicesTtl) return

        this.autoAt = this.now()

        try {
            const result = await detectBackend(this.deps.http, auto)
            this.autoResult = result
            this.autoBackend = buildAutoBackend(auto, result)

            if (result.ok) {
                this.logger.info(
                    `[vitspro] 自动探测：${result.kind} · ${result.baseUrl}`
                )
            } else {
                this.logger.warn(
                    `[vitspro] 自动探测失败：${result.hint ?? '未知原因'}（vitsdebug probe 看细节）`
                )
            }
        } catch (error) {
            this.autoResult = undefined
            this.autoBackend = undefined
            this.logger.warn(
                `[vitspro] 自动探测出错：${(error as Error)?.message ?? error}`
            )
        }
    }

    /** 手动后端 + 自动探测出的后端（同类型同地址去重） */
    private allBackends(): Backend[] {
        const manual = this.deps.backends()
        if (!this.autoBackend) return manual

        const sameUrl = (left?: string, right?: string) =>
            String(left ?? '')
                .trim()
                .toLowerCase()
                .replace(/\/+$/, '') ===
            String(right ?? '')
                .trim()
                .toLowerCase()
                .replace(/\/+$/, '')

        const exists = manual.some(
            (item) =>
                item.type === this.autoBackend!.type &&
                sameUrl((item as any).url, (this.autoBackend as any).url)
        )

        return exists ? manual : [...manual, this.autoBackend]
    }

    /** 自动探测结果（给 vitsdebug 展示） */
    getAutoResult(): DetectResult | undefined {
        return this.autoResult
    }

    /** 立即跑一次协议探测（不写缓存），供 vitsdebug probe 使用 */
    async detect(): Promise<DetectResult | undefined> {
        const auto = this.deps.config.auto
        if (!auto || !auto.enabled || !String(auto.url ?? '').trim()) return undefined
        return detectBackend(this.deps.http, auto)
    }

    private async loadVoices(): Promise<void> {
        await this.ensureAuto()
        const backends = this.allBackends().filter(
            (item) => item.enabled !== false
        )
        const collected = new Map<string, VoiceEntry>()
        let stale = false

        for (const backend of backends) {
            const adapter = this.adapters[backend.type]
            if (!adapter) continue

            const wantsPull =
                adapter.autoPull && backend.autoPullSpeaker !== false
            let speakers: SpeakerBase[] = []
            let failed = false

            try {
                speakers = await adapter.getSpeakers(backend)
            } catch (error) {
                failed = true
                speakers = backend.speakers ?? []
                this.logger.warn(
                    `[vitspro] 拉取 ${
                        backend.label ?? backend.type
                    } 讲者失败（后端可能还没启动）：${
                        (error as Error)?.message ?? error
                    }`
                )
            }

            // 需要自动拉取却一个都没拿到：视为「还没就绪」，保留后台重试
            if (wantsPull && speakers.length === 0) failed = true
            if (failed) stale = true

            const backendLabel = backend.label ?? backend.type

            for (const speaker of speakers) {
                const languages =
                    speaker.languages && speaker.languages.length > 0
                        ? speaker.languages
                        : [undefined]

                for (const language of languages) {
                    const key = `${backendLabel}/${speaker.name}${
                        language ? `_${language}` : ''
                    }`
                    if (collected.has(key)) continue
                    collected.set(key, {
                        id: 0,
                        key,
                        name: speaker.name,
                        language,
                        backendLabel,
                        backend,
                        speaker
                    })
                }
            }
        }

        const list = [...collected.values()].sort((a, b) =>
            a.key.localeCompare(b.key)
        )
        list.forEach((entry, index) => {
            entry.id = index + 1
        })

        this.voices = list
        this.voicesLoaded = true
        this.voicesStale = stale
        this.lastLoadAt = this.now()
    }

    /** 按 id / 完整 key / 讲者名 / 默认讲者 解析出实际讲者 */
    async resolveVoice(
        speakerId?: number,
        speakerName?: string
    ): Promise<VoiceEntry | undefined> {
        const voices = await this.ensureVoices()
        if (voices.length === 0) return undefined

        if (speakerId != null && speakerId > 0) {
            const byId = voices.find((voice) => voice.id === speakerId)
            if (byId) return byId
        }

        const wanted = speakerName ?? this.deps.config.defaultSpeaker
        if (wanted) {
            return matchVoice(voices, wanted)
        }

        return voices[0]
    }

    /**
     * 讲者可能因为「后端比 Koishi 启动慢」而暂时为空：
     * 解析失败时强制刷新一次（受 5s 冷却保护），再解析一次。
     */
    private async resolveVoiceWithRetry(
        speakerId?: number,
        speakerName?: string
    ): Promise<VoiceEntry | undefined> {
        const voice = await this.resolveVoice(speakerId, speakerName)
        if (voice) return voice

        await this.ensureVoices(true)
        return this.resolveVoice(speakerId, speakerName)
    }

    // -----------------------------------------------------------------------
    // 开关（`tts off` / `tts on`）
    // -----------------------------------------------------------------------

    setEnabled(value: boolean): void {
        this.enabled = value
    }

    isEnabled(): boolean {
        return this.enabled
    }

    // -----------------------------------------------------------------------
    // 对外入口
    // -----------------------------------------------------------------------

    async say(options: SayOptions): Promise<ElementLike> {
        const session = options.session
        const normalized = normalize(options.input, this.deps.config.text)
        const source = options.source ?? detectSource(normalized, options)

        if (normalized.unknownTags.length > 0) {
            this.logger.debug(
                `[vitspro] 输入里仍有未知标签：${normalized.unknownTags.join(', ')}`
            )
        }

        const voice = await this.resolveVoiceWithRetry(
            options.speaker_id,
            undefined
        )
        return this.synthesizeNormalized(normalized.text, source, voice, session)
    }

    /** 供指令 / chatluna 工具调用：文本直接合成，不经过 speaker_id 映射 */
    async synthesize(text: string, options: SynthesizeOptions = {}): Promise<ElementLike> {
        const normalized = normalize(text, this.deps.config.text)
        const source: Source = options.source ?? 'command'
        const voice = await this.resolveVoiceWithRetry(
            undefined,
            options.speaker
        )
        return this.synthesizeNormalized(
            normalized.text,
            source,
            voice,
            options.session
        )
    }

    /** `tts debug`：只算不做，把决策链路完整打印出来 */
    async explain(text: string, speakerId?: number) {
        const normalized = normalize(text, this.deps.config.text)
        const source = detectSource(normalized, { input: text })
        const chars = speakableLength(normalized.text)
        const decision = decidePlan(
            source,
            chars,
            isEffectivelyEmpty(normalized.text),
            {
                minChars: this.deps.config.toolCall.minChars,
                maxChars: this.deps.config.toolCall.maxChars,
                maxTextChars: this.deps.config.command.maxTextChars
            }
        )
        const voice = await this.resolveVoice(speakerId)

        return {
            raw: text,
            text: normalized.text,
            hadMarkup: normalized.hadMarkup,
            unknownTags: normalized.unknownTags,
            source,
            chars,
            decision,
            segments: splitText(normalized.text, this.splitOptions()),
            voice: voice ? voice.key : null,
            timeout: voice ? this.computeTimeout(voice, chars) : 0
        }
    }

    private async synthesizeNormalized(
        text: string,
        source: Source,
        voice: VoiceEntry | undefined,
        session: any
    ): Promise<ElementLike> {
        const chars = speakableLength(text)
        const empty = isEffectivelyEmpty(text)
        const decision = decidePlan(source, chars, empty, {
            minChars: this.deps.config.toolCall.minChars,
            maxChars: this.deps.config.toolCall.maxChars,
            maxTextChars: this.deps.config.command.maxTextChars
        })

        if (decision.action === 'text') {
            return this.degrade(text, source, decision.reason!, session, 'plan')
        }

        if (!this.enabled) {
            return this.degrade(text, source, 'DISABLED', session, 'disabled')
        }

        if (!voice) {
            return this.degrade(text, source, 'NO_SPEAKER', session, 'speaker')
        }

        if (
            chars * SECONDS_PER_CHAR >
            this.deps.config.aggregate.maxAudioSeconds
        ) {
            return this.degrade(text, source, 'TOO_LONG', session, 'duration')
        }

        const scopeKey = this.scopeKey(voice)
        const check = this.breaker.canRequest(scopeKey)
        if (!check.allowed) {
            return this.degrade(text, source, 'CIRCUIT_OPEN', session, this.backendKey(voice.backend))
        }

        const segments = splitText(text, this.splitOptions())
        const results = await mapWithConcurrency(
            segments,
            this.deps.config.split.concurrency,
            (segment) => this.synthesizeSegment(voice, segment, session, check.probe)
        )

        const ok = results.filter(
            (item): item is AudioResult => !(item instanceof Error)
        )
        const failed = results.filter(
            (item): item is Error => item instanceof Error
        )

        if (ok.length === 0) {
            const error = failed[0]
            const code: DegradeCode =
                classifyError(error) === 'TIMEOUT'
                    ? 'TIMEOUT'
                    : 'ALL_SEGMENTS_FAILED'
            this.logger.warn(
                `[vitspro] 合成失败：${(error as Error)?.message ?? error}`
            )
            return this.degrade(text, source, code, session, this.backendKey(voice.backend))
        }

        if (
            failed.length > 0 &&
            this.deps.config.aggregate.partialPolicy === 'all-or-nothing'
        ) {
            return this.degrade(text, source, 'ALL_SEGMENTS_FAILED', session, this.backendKey(voice.backend))
        }

        return this.deliver(ok, session)
    }

    private splitOptions(): SplitOptions {
        const { split } = this.deps.config
        return {
            mode: split.mode,
            allowFallback: split.allowFallback,
            minSegmentChars: split.minSegmentChars,
            maxSegmentChars: split.maxSegmentChars,
            maxSegments: split.maxSegments
        }
    }

    private async synthesizeSegment(
        voice: VoiceEntry,
        text: string,
        session: any,
        probe: boolean
    ): Promise<AudioResult> {
        const chars = speakableLength(text)
        const timeout = this.computeTimeout(voice, chars)
        const adapter = this.adapters[voice.backend.type]
        const backendKey = this.backendKey(voice.backend)
        const scopeKey = this.scopeKey(voice)
        const started = this.now()

        try {
            const result = await withTimeout(
                adapter.synthesize({
                    text,
                    backend: voice.backend,
                    speaker: voice.speaker,
                    language: voice.language,
                    timeout,
                    session
                }),
                timeout,
                `${voice.backendLabel} tts`
            )

            this.breaker.recordSuccess(scopeKey)
            this.estimator.record(
                backendKey,
                chars,
                this.now() - started,
                'real'
            )
            this.estimator.recordSuccess(backendKey)

            return result
        } catch (error) {
            const errorClass = classifyError(error)

            if (probe) this.breaker.recordProbeFailure(scopeKey)
            else this.breaker.recordFailure(scopeKey, errorClass)

            if (errorClass === 'TIMEOUT') this.estimator.bumpPenalty(backendKey)

            this.logger.debug(
                `[vitspro] ${voice.key} 合成失败（${errorClass}）：${
                    (error as Error)?.message ?? error
                }`
            )
            throw error
        }
    }

    private deliver(results: AudioResult[], session: any): ElementLike {
        const sentOnly = results.filter((item) => item.sent)
        if (sentOnly.length === results.length) {
            return textElement('')
        }

        const buffers = results.map((item) => item.data)
        const mime = results[0].mime
        const aggregate = this.deps.config.aggregate.type

        if (aggregate !== 'multi' && /wav|wave/i.test(mime)) {
            const merged = mergeWavs(buffers)
            if (merged.ok) {
                return audioElement(merged.data, shortFormat('audio/wav'))
            }
            if (aggregate === 'concat') {
                this.logger.warn(
                    `[vitspro] WAV 拼接失败（${merged.reason}），降级为多段发送`
                )
            }
        }

        const [first, ...rest] = results
        if (session && rest.length > 0) {
            for (const item of rest) {
                void Promise.resolve(
                    session.send(audioElement(item.data, shortFormat(item.mime)))
                ).catch((error: unknown) => {
                    this.logger.warn(
                        `[vitspro] 补发语音失败：${(error as Error)?.message ?? error}`
                    )
                })
            }
        } else if (rest.length > 0) {
            this.logger.warn(
                `[vitspro] 无法拼接且没有 session，只发送了第一段（共 ${results.length} 段）`
            )
        }

        return audioElement(first.data, shortFormat(first.mime))
    }

    // -----------------------------------------------------------------------
    // 降级
    // -----------------------------------------------------------------------

    private async degrade(
        text: string,
        source: Source,
        code: DegradeCode,
        session: any,
        scope = 'global'
    ): Promise<ElementLike> {
        await this.notify(text, code, session, scope)

        const action = degradeActionFor(source, this.deps.config.degrade)

        // 空文本没有可发的东西：直接抛给调用方，避免发出空 text 元素
        // （部分平台编码器会因此拿到 undefined 并崩溃）
        if (action === 'error' || code === 'EMPTY_TEXT') {
            throw new VitsDegradeError(code, text)
        }
        return textElement(text)
    }

    private async notify(
        text: string,
        code: DegradeCode,
        session: any,
        scope: string
    ): Promise<void> {
        if (!this.notice.enabled || !session) return
        if (code === 'EMPTY_TEXT') return
        if (!this.notice.shouldNotify(scope)) return

        const message = `（语音暂不可用，已转为文字：${NOTICE_REASON[code]}）`
        try {
            await Promise.resolve(session.send(message))
        } catch (error) {
            this.logger.debug(
                `[vitspro] 提示发送失败：${(error as Error)?.message ?? error}`
            )
        }
    }

    // -----------------------------------------------------------------------
    // 状态与基准测试
    // -----------------------------------------------------------------------

    private computeTimeout(voice: VoiceEntry, chars: number): number {
        const { timeout } = this.deps.config
        if (voice.backend.timeout != null) return voice.backend.timeout
        if (timeout.mode === 'manual') return timeout.manual

        const key = this.backendKey(voice.backend)
        // 还没有足够样本时用冷启动预算，避免第一句被兜底公式误杀
        if (this.estimator.count(key) < 3) {
            return Math.max(timeout.min, timeout.coldStart)
        }

        const estimate = this.estimator.estimateMs(key, chars)
        const value = timeout.overhead + timeout.factor * estimate
        return Math.round(Math.min(timeout.max, Math.max(timeout.min, value)))
    }

    private backendKey(backend: Backend): string {
        const label = backend.label ?? backend.type
        return `${label}:${backend.type}`
    }

    private scopeKey(voice: VoiceEntry): string {
        return this.deps.config.breaker.scope === 'speaker'
            ? voice.key
            : this.backendKey(voice.backend)
    }

    async status(): Promise<BackendStatus[]> {
        const voices = await this.ensureVoices()
        await this.ensureAuto()
        const backends = this.allBackends().filter(
            (item) => item.enabled !== false
        )

        return backends.map((backend) => {
            const label = backend.label ?? backend.type
            const key = this.backendKey(backend)
            const view = this.breaker.view(key)
            const estimate = this.estimator.estimate(key, 60)

            return {
                label,
                type: backend.type,
                speakers: voices.filter((voice) => voice.backend === backend)
                    .length,
                state: view.state,
                failures: view.failures,
                estimate: {
                    a: Math.round(estimate.a),
                    b: Math.round(estimate.b * 10) / 10,
                    samples: estimate.samples,
                    source: estimate.source
                },
                suggestedTimeout: this.estimateSuggestedTimeout(backend, 60)
            }
        })
    }

    private estimateSuggestedTimeout(backend: Backend, chars: number): number {
        if (backend.timeout != null) return backend.timeout
        const { timeout } = this.deps.config
        if (timeout.mode === 'manual') return timeout.manual

        const key = this.backendKey(backend)
        if (this.estimator.count(key) < 3) {
            return Math.max(timeout.min, timeout.coldStart)
        }

        const estimate = this.estimator.estimateMs(key, chars)
        return Math.round(
            Math.min(
                timeout.max,
                Math.max(
                    timeout.min,
                    timeout.overhead + timeout.factor * estimate
                )
            )
        )
    }

    /**
     * `tts probe`：对每个后端真实跑一次讲者探测，把 URL / 状态 / 错误带回来。
     * 只诊断，不改缓存（刷新请用 `tts reload`）。
     */
    async probe(label?: string): Promise<SpeakerProbe[]> {
        await this.ensureAuto()
        const backends = this.allBackends().filter(
            (backend) =>
                backend.enabled !== false &&
                (label == null ||
                    (backend.label ?? backend.type) === label ||
                    backend.type === label)
        )

        const results: SpeakerProbe[] = []
        for (const backend of backends) {
            const adapter = this.adapters[backend.type]
            if (!adapter) continue
            results.push(await adapter.probeSpeakers(backend))
        }
        return results
    }

    /**
     * 长度阶梯基准：每档重复 N 次取中位，结果写回 estimator，
     * 下一条真实消息立刻用新参数算超时。
     */
    async bench(
        label?: string,
        speakerName?: string,
        repeat?: number
    ): Promise<BenchReport[]> {
        await this.ensureAuto()
        const repeatCount = Math.max(1, repeat ?? this.deps.config.bench.repeat)
        const voices = await this.ensureVoices()
        const backends = this.allBackends().filter(
            (item) =>
                item.enabled !== false &&
                (label == null ||
                    (item.label ?? item.type) === label ||
                    item.type === label)
        )

        const reports: BenchReport[] = []

        for (const backend of backends) {
            const voice = speakerName
                ? voices.find(
                      (item) =>
                          item.backend === backend &&
                          item.key.toLowerCase().includes(speakerName.toLowerCase())
                  )
                : voices.find((item) => item.backend === backend)
            const backendLabel = backend.label ?? backend.type

            if (!voice) {
                reports.push({
                    label: backendLabel,
                    points: [],
                    a: 0,
                    b: 0,
                    suggestedTimeout: 0,
                    samples: 0,
                    state: this.breaker.view(this.backendKey(backend)).state,
                    skipped: '没有可用讲者'
                })
                continue
            }

            const points: BenchPoint[] = []
            for (const chars of this.deps.config.bench.ladder) {
                const text = probeText(chars)
                const times: number[] = []
                let failed = 0

                for (let i = 0; i < repeatCount; i++) {
                    const started = this.now()
                    try {
                        await withTimeout(
                            this.adapters[backend.type].synthesize({
                                text,
                                backend,
                                speaker: voice.speaker,
                                language: voice.language,
                                timeout:
                                    backend.timeout ??
                                    this.deps.config.timeout.max
                            }),
                            this.deps.config.timeout.max,
                            `${backendLabel} bench`
                        )
                        const ms = this.now() - started
                        times.push(ms)
                        this.estimator.record(
                            this.backendKey(backend),
                            speakableLength(text),
                            ms,
                            'probe'
                        )
                    } catch (error) {
                        failed += 1
                        this.logger.debug(
                            `[vitspro] bench ${backendLabel} ${chars} 字失败：${
                                (error as Error)?.message ?? error
                            }`
                        )
                    }
                }

                points.push({
                    chars,
                    medianMs: median(times),
                    samples: times.length,
                    failed
                })
            }

            const key = this.backendKey(backend)
            const estimate = this.estimator.estimate(key, 60)

            reports.push({
                label: backendLabel,
                points,
                a: Math.round(estimate.a),
                b: Math.round(estimate.b * 10) / 10,
                suggestedTimeout: this.estimateSuggestedTimeout(backend, 60),
                samples: this.estimator.count(key),
                state: this.breaker.view(key).state
            })
        }

        return reports
    }

    reset(backendLabel?: string): void {
        const backends = this.allBackends()
        const targets =
            backendLabel == null
                ? backends
                : backends.filter(
                      (item) =>
                          (item.label ?? item.type) === backendLabel ||
                          item.type === backendLabel
                  )

        for (const backend of targets) {
            this.estimator.reset(this.backendKey(backend))
            this.breaker.reset(this.backendKey(backend))
        }
        if (backendLabel == null) {
            this.estimator.reset()
            this.breaker.reset()
            this.notice.reset()
        }
    }
}

function detectSource(
    normalized: NormalizeResult,
    options: SayOptions
): Source {
    if (normalized.hadMarkup || (options.input && detectMarkup(options.input)))
        return 'tool'
    if (options.session != null && options.speaker_id != null) return 'service'
    return 'command'
}

function matchVoice(voices: VoiceEntry[], wanted: string): VoiceEntry | undefined {
    const exact = voices.find((voice) => voice.key === wanted)
    if (exact) return exact

    const suffix = voices.find((voice) => voice.key.endsWith(wanted))
    if (suffix) return suffix

    const byName = voices.find((voice) => voice.name === wanted)
    if (byName) return byName

    return voices.find((voice) =>
        voice.key.toLowerCase().includes(wanted.toLowerCase())
    )
}

function probeText(chars: number): string {
    const base = '这是一段用来测量语音合成速度的测试文本，长度按需截取。'
    let text = ''
    while (text.length < chars) text += base
    return text.slice(0, Math.max(1, chars))
}

function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : Math.round(sorted[mid])
}








