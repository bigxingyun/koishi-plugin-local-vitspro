import { Schema } from 'koishi'
import {
    AggregateType,
    Backend,
    BreakerConfig,
    BreakerMode,
    BreakerScope,
    ChatlunaToolConfig,
    DegradeAction,
    DegradeCode,
    NoticeMode,
    SplitMode,
    TimeoutMode
} from './types'

// ---------------------------------------------------------------------------
// 讲者
// ---------------------------------------------------------------------------

const BaseSpeaker = {
    name: Schema.string().required().description('讲者名（展示用，也是默认匹配键）')
}

const VitsSimpleApiSpeaker = Schema.object({
    ...BaseSpeaker,
    id: Schema.natural().description('后端讲者 id'),
    type: Schema.union(['VITS', 'W2V2-VITS', 'BERT-VITS2', 'GPT-SOVITS'])
        .default('VITS')
        .description('讲者类型，决定请求的接口路径与参数'),
    languages: Schema.array(Schema.string())
        .default([])
        .description('该讲者支持的语言（大写，如 ZH / EN / JA）'),
    format: Schema.string().default('wav').description('音频格式'),
    noise: Schema.number().description('感情强度（VITS / BERT-VITS2）'),
    noise_w: Schema.number().description('音素长度（VITS / BERT-VITS2）'),
    length: Schema.number().description('语速（VITS / BERT-VITS2）'),
    sdp_ratio: Schema.number().description('SDP/DP 混合比（BERT-VITS2）'),
    segment_size: Schema.number().description('分段大小（GPT-SOVITS）'),
    emotion: Schema.number().description('情感（W2V2-VITS）'),
    preset: Schema.string().description('vits-simple-api 预设名（GPT-SOVITS）'),
    prompt_text: Schema.string().description('参考文本（GPT-SOVITS）'),
    prompt_lang: Schema.string().description('参考文本语言（GPT-SOVITS）'),
    reference_audio: Schema.string().description(
        '参考音频的**服务端**绝对路径（GPT-SOVITS）'
    ),
    text_prompt: Schema.string().description('文本提示（BERT-VITS2）')
}).description('vits-simple-api 讲者')

const GptSovits2Speaker = Schema.object({
    ...BaseSpeaker,
    gpt_weights: Schema.string().description('GPT 底模路径（服务端），不填则不切换'),
    sovits_weights: Schema.string().description('SoVITS 底模路径（服务端），不填则不切换'),
    ref_audio_path: Schema.string().description(
        '参考音频路径（服务端；v2 必填，v1 即 refer_wav_path）'
    ),
    aux_ref_audio_paths: Schema.array(Schema.string())
        .default([])
        .description('辅助参考音频路径（v1 即 inp_refs）'),
    prompt_text: Schema.string().description('参考文本'),
    prompt_lang: Schema.string().default('zh').description('参考文本语言'),
    text_lang: Schema.string().description('合成语言，不填则跟随 key 后缀 / 默认 zh'),
    languages: Schema.array(Schema.string())
        .default([])
        .description('该讲者支持的语言；填了会按语言生成多个讲者 key（如 丛雨_ZH）'),
    text_split_method: Schema.string().description('后端自带切句方法，默认 cut5'),
    batch_size: Schema.number(),
    speed_factor: Schema.number().description('语速（v1 用 speed）'),
    speed: Schema.number().description('语速（v1）'),
    top_k: Schema.number(),
    top_p: Schema.number(),
    temperature: Schema.number(),
    sample_steps: Schema.number().description('采样步数（v3/v4 模型）'),
    cfg_rate: Schema.number().description('cfg 强度（v3/v4 模型）'),
    media_type: Schema.string().default('wav').description('wav 最稳，raw 无头')
}).description('GPT-SoVITS 讲者')

const FishAudioSpeaker = Schema.object({
    ...BaseSpeaker,
    reference_id: Schema.string().required().description('fish.audio 模型 id'),
    languages: Schema.array(Schema.string()).default([]).description('支持的语言'),
    format: Schema.union(['wav', 'pcm', 'mp3']).default('wav'),
    chunk_length: Schema.number().default(50),
    normalize: Schema.boolean().default(true),
    latency: Schema.union(['normal', 'balanced']).default('normal'),
    mp3_bitrate: Schema.union([64, 128, 192]).default(64)
}).description('fish-audio 讲者')

const QQVoiceSpeaker = Schema.object({
    ...BaseSpeaker,
    characterId: Schema.string().required().description('QQ 声聊角色 id')
}).description('QQ 声聊讲者')

// ---------------------------------------------------------------------------
// 后端
// ---------------------------------------------------------------------------

const VitsSimpleApiBackend = Schema.object({
    type: Schema.const('vits-simple-api').description('vits-simple-api'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    url: Schema.string().required().description('服务地址，如 http://127.0.0.1:23456'),
    apiKey: Schema.string().role('secret').description('X-API-KEY'),
    username: Schema.string().description('HTTP Basic Auth 用户名'),
    password: Schema.string().role('secret').description('HTTP Basic Auth 密码'),
    timeout: Schema.number().description('后端级超时（毫秒）'),
    autoPullSpeaker: Schema.boolean()
        .default(true)
        .description('从 /voice/speakers 自动拉取讲者'),
    headers: Schema.dict(Schema.string()).default({}).description('附加请求头'),
    speakers: Schema.array(VitsSimpleApiSpeaker).default([])
}).description('vits-simple-api')

const GptSovits2Backend = Schema.object({
    type: Schema.const('GPT-SoVITS2').description('GPT-SoVITS'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    url: Schema.string().required().description('服务地址，如 http://127.0.0.1:9880'),
    apiVersion: Schema.union(['v2', 'v1'])
        .default('v2')
        .description('v2=api_v2.py（/tts）；v1=老版 api.py（/）'),
    method: Schema.union(['auto', 'get', 'post'])
        .default('auto')
        .description('auto=先 POST，405/404 时回退 GET'),
    timeout: Schema.number().description('后端级超时（毫秒）'),
    headers: Schema.dict(Schema.string()).default({}).description('附加请求头'),
    config: Schema.object({
        text_split_method: Schema.string().default('cut5'),
        batch_size: Schema.number().default(1),
        batch_threshold: Schema.number().default(0.75),
        split_bucket: Schema.boolean().default(true),
        speed_factor: Schema.number().default(1),
        fragment_interval: Schema.number().default(0.3),
        top_k: Schema.number().default(15),
        top_p: Schema.number().default(1),
        temperature: Schema.number().default(1),
        seed: Schema.number().default(-1),
        media_type: Schema.string().default('wav'),
        streaming_mode: Schema.boolean().default(false),
        parallel_infer: Schema.boolean().default(true),
        use_cuda_graph: Schema.boolean().default(true),
        repetition_penalty: Schema.number().default(1.35),
        sample_steps: Schema.number().description('v3/v4 采样步数'),
        cfg_rate: Schema.number().description('v3/v4 cfg 强度'),
        super_sampling: Schema.boolean().default(false),
        cut_punc: Schema.string().description('v1 切句标点'),
        speed: Schema.number().description('v1 语速'),
        if_sr: Schema.boolean().description('v1 超分')
    })
        .description('全局默认请求参数（讲者里可覆盖）')
        .default({} as never),
    speakers: Schema.array(GptSovits2Speaker).default([])
}).description('GPT-SoVITS（v2 / v1）')

const FishAudioBackend = Schema.object({
    type: Schema.const('fish-audio').description('fish-audio'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    baseUrl: Schema.string().default('https://api.fish.audio'),
    apiKey: Schema.string().role('secret').required().description('fish.audio API Key'),
    timeout: Schema.number().description('后端级超时（毫秒）'),
    headers: Schema.dict(Schema.string()).default({}).description('附加请求头'),
    speakers: Schema.array(FishAudioSpeaker).default([])
}).description('fish-audio')

const QQVoiceBackend = Schema.object({
    type: Schema.const('qq-voice').description('QQ 声聊'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    accountId: Schema.string().description('机器人 QQ 号'),
    speakers: Schema.array(QQVoiceSpeaker).default([])
}).description('QQ 声聊')

export const backendSchema: Schema<Backend> = Schema.union([
    VitsSimpleApiBackend,
    GptSovits2Backend,
    FishAudioBackend,
    QQVoiceBackend
]) as unknown as Schema<Backend>

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface TextConfig {
    stripMarkdown: boolean
    stripEmoji: boolean
    newlineAs: 'space' | 'period'
    blockJoin: string
    extraTags: string[]
}

export interface SplitConfig {
    mode: SplitMode
    allowFallback: boolean
    minSegmentChars: number
    maxSegmentChars: number
    maxSegments: number
    concurrency: number
}

export interface AggregateConfig {
    type: AggregateType
    maxAudioSeconds: number
    partialPolicy: 'keep-ok' | 'all-or-nothing'
}

export interface TimeoutConfig {
    mode: TimeoutMode
    manual: number
    factor: number
    min: number
    max: number
    overhead: number
}

export interface NoticeConfig {
    mode: NoticeMode
    interval: number
}

export interface ToolCallConfig {
    minChars: number
    maxChars: number
}

export interface DegradeConfig {
    tool: DegradeAction
    service: DegradeAction
    command: DegradeAction
}

export interface CommandConfig {
    maxTextChars: number
}

export interface BenchConfig {
    enabled: boolean
    ladder: number[]
    repeat: number
}

export interface Config {
    defaultSpeaker: string
    backendsSource: 'schema' | 'file'
    backendsFile: string
    backends: Backend[]

    text: TextConfig
    split: SplitConfig
    aggregate: AggregateConfig
    timeout: TimeoutConfig
    breaker: BreakerConfig
    notice: NoticeConfig
    toolCall: ToolCallConfig
    degrade: DegradeConfig
    command: CommandConfig
    bench: BenchConfig
    chatlunaTool: ChatlunaToolConfig
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        defaultSpeaker: Schema.dynamic('speaker')
            .default('')
            .description('全局默认讲者（`tts speakers` 可查）'),
        backendsSource: Schema.union(['schema', 'file'])
            .default('schema')
            .description(
                '后端来源：schema=控制台配置；file=读一份 YAML（不读旧插件路径）'
            ),
        backendsFile: Schema.string()
            .default('data/local-vitspro/config.yml')
            .description('file 模式的后端列表路径'),
        backends: Schema.array(backendSchema)
            .default([])
            .description(
                '后端列表。同一份配置里可以放多个后端，讲者 key 会带上后端名去重'
            )
    }).description('基础'),

    Schema.object({
        text: Schema.object({
            stripMarkdown: Schema.boolean().default(true),
            stripEmoji: Schema.boolean().default(true),
            newlineAs: Schema.union(['space', 'period'])
                .default('space')
                .description('换行如何处理：空格 / 句号'),
            blockJoin: Schema.string()
                .default('')
                .description('多个 <message> 块之间的连接符'),
            extraTags: Schema.array(Schema.string())
                .default([])
                .description('额外需要解包的标签名（保留内层文本）')
        }).description('文本归一化')
    }).description('文本处理'),

    Schema.object({
        split: Schema.object({
            mode: Schema.union([
                'none',
                'zh_period',
                'zh_comma',
                'en_period',
                'en_comma'
            ])
                .default('zh_period')
                .description(
                    '切片模式：none 不切 / zh_period 中文句号 / zh_comma 中文逗号 / en_period 英文句号 / en_comma 英文逗号'
                ),
            allowFallback: Schema.boolean()
                .default(true)
                .description('找不到主标点时允许降级（逗号 → 空格 → 硬切）'),
            minSegmentChars: Schema.natural()
                .min(1)
                .default(8)
                .description('短于该字数的段并入相邻段'),
            maxSegmentChars: Schema.natural()
                .min(10)
                .default(120)
                .description('单段字符上限'),
            maxSegments: Schema.natural()
                .min(1)
                .default(8)
                .description('段数上限，超出合并尾段'),
            concurrency: Schema.natural()
                .min(1)
                .max(8)
                .default(2)
                .description('并行合成数')
        }).description('切片')
    }).description('切片'),

    Schema.object({
        aggregate: Schema.object({
            type: Schema.union(['auto', 'concat', 'multi'])
                .default('auto')
                .description('auto=能拼就拼，否则多段；concat=只拼；multi=永远多段'),
            maxAudioSeconds: Schema.number()
                .min(1)
                .default(55)
                .description('估算超过该时长就先切片/转文字（QQ 语音约 60s 上限）'),
            partialPolicy: Schema.union(['keep-ok', 'all-or-nothing'])
                .default('keep-ok')
                .description('部分段失败时的取舍')
        }).description('音频聚合')
    }).description('聚合'),

    Schema.object({
        timeout: Schema.object({
            mode: Schema.union(['auto', 'manual'])
                .default('auto')
                .description('auto=按测速模型动态计算；manual=固定 manual 值'),
            manual: Schema.number()
                .default(60000)
                .description('manual 模式下的固定超时（毫秒）'),
            factor: Schema.number()
                .default(2)
                .description('auto 模式的安全系数'),
            min: Schema.number().default(5000).description('超时下限（毫秒）'),
            max: Schema.number().default(120000).description('超时上限（毫秒）'),
            overhead: Schema.number()
                .default(800)
                .description('固定开销（毫秒），叠加在估算值上')
        }).description('超时'),
        breaker: Schema.object({
            mode: Schema.union(['auto', 'manual', 'off'])
                .default('auto')
                .description('auto=退避 + 半开；manual=固定冷却；off=永不熔断'),
            scope: Schema.union(['backend', 'speaker'])
                .default('backend')
                .description('熔断粒度'),
            failureThreshold: Schema.natural()
                .min(1)
                .default(2)
                .description('连续失败多少次熔断'),
            cooldown: Schema.number()
                .default(30000)
                .description('首次冷却（毫秒）'),
            maxCooldown: Schema.number()
                .default(600000)
                .description('冷却上限（毫秒）')
        }).description('熔断'),
        notice: Schema.object({
            mode: Schema.union(['off', 'session', 'admin'])
                .default('session')
                .description('降级提示发给谁'),
            interval: Schema.number()
                .default(600000)
                .description('同一原因的最小提示间隔（毫秒）')
        }).description('降级提示')
    }).description('超时与熔断'),

    Schema.object({
        toolCall: Schema.object({
            minChars: Schema.natural()
                .default(2)
                .description('低于该字数不合成（工具路径）'),
            maxChars: Schema.natural()
                .default(300)
                .description('高于该字数不合成（工具路径）')
        }).description('工具调用阈值'),
        degrade: Schema.object({
            tool: Schema.union(['error', 'text'])
                .default('error')
                .description('工具路径（chatluna-character）：抛错让调用方兜底'),
            service: Schema.union(['error', 'text'])
                .default('text')
                .description(
                    '服务路径（chatluna 渲染器）：回纯文本，避免抛错丢整条回复'
                ),
            command: Schema.union(['error', 'text'])
                .default('text')
                .description('指令路径')
        }).description('降级方式'),
        command: Schema.object({
            maxTextChars: Schema.natural()
                .default(2000)
                .description('指令路径的合成字数上限')
        }).description('指令')
    }).description('工具调用与降级'),

    Schema.object({
        bench: Schema.object({
            enabled: Schema.boolean().default(true),
            ladder: Schema.array(Schema.natural().min(1))
                .default([6, 12, 24])
                .description('长度阶梯（字）'),
            repeat: Schema.natural()
                .min(1)
                .default(2)
                .description('每档重复次数，取中位')
        }).description('基准测试（权限固定为管理员 authority=3）')
    }).description('基准测试'),

    Schema.object({
        chatlunaTool: Schema.object({
            enabled: Schema.boolean().default(true),
            name: Schema.string().default('vits_say'),
            sendAudio: Schema.boolean()
                .default(true)
                .description('工具直接发送语音到会话'),
            authority: Schema.natural()
                .default(1)
                .description('允许触发该工具的权限等级')
        }).description('chatluna 工具（未安装 chatluna 时自动跳过）')
    }).description('chatluna 工具')
]) as unknown as Schema<Config>

export const name = 'local-vitspro'
