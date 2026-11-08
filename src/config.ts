import { Schema } from 'koishi'
import {
    AggregateType,
    Backend,
    BreakerConfig,
    BreakerMode,
    BreakerScope,
    AutoConfig,
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
    noise_w: Schema.number().hidden(),
    length: Schema.number().description('语速（VITS / BERT-VITS2）'),
    sdp_ratio: Schema.number().hidden(),
    segment_size: Schema.number().hidden(),
    emotion: Schema.number().hidden(),
    preset: Schema.string().hidden(),
    prompt_text: Schema.string().hidden(),
    prompt_lang: Schema.string().hidden(),
    reference_audio: Schema.string().hidden(),
    text_prompt: Schema.string().hidden()
}).description('vits-simple-api 讲者')

const GptSovits2Speaker = Schema.object({
    ...BaseSpeaker,
    gpt_weights: Schema.string().description(
        'GPT 模型路径（服务端相对路径，如 GPT_weights_v4/银狼-e5.ckpt）；接口不能列模型，手动填 WebUI 下拉里的值'
    ),
    sovits_weights: Schema.string().description(
        'SoVITS 模型路径（服务端相对路径，如 SoVITS_weights_v4/银狼_e1_s199_l32.pth）'
    ),
    ref_audio_path: Schema.string().description(
        '参考音频（服务端路径，3~10 秒）；v2/v3/v4/v5 必填，v1 即 refer_wav_path'
    ),
    aux_ref_audio_paths: Schema.array(Schema.string())
        .default([])
        .description('辅助参考音频路径（v1 即 inp_refs）'),
    prompt_text: Schema.string().description(
        '参考音频对应的原文；v3/v4/v5 必填（不支持空参考文本）'
    ),
    prompt_lang: Schema.string().default('zh').description('参考文本语言'),
    text_lang: Schema.string().description('合成语言，不填则跟随 key 后缀 / 默认 zh'),
    languages: Schema.array(Schema.string())
        .default([])
        .description('该讲者支持的语言；填了会按语言生成多个讲者 key（如 丛雨_ZH）'),
    text_split_method: Schema.string().hidden(),
    batch_size: Schema.number().hidden(),
    speed_factor: Schema.number().description('语速（v1 用 speed）'),
    speed: Schema.number().hidden(),
    top_k: Schema.number().hidden(),
    top_p: Schema.number().hidden(),
    temperature: Schema.number().hidden(),
    sample_steps: Schema.number().hidden(),
    cfg_rate: Schema.number().hidden(),
    media_type: Schema.string().default('wav').description('wav 最稳，raw 无头')
}).description('GPT-SoVITS 讲者')

const FishAudioSpeaker = Schema.object({
    ...BaseSpeaker,
    reference_id: Schema.string().required().description('fish.audio 模型 id'),
    languages: Schema.array(Schema.string()).default([]).description('支持的语言'),
    format: Schema.union(['wav', 'pcm', 'mp3']).default('wav'),
    chunk_length: Schema.number().default(50).hidden(),
    normalize: Schema.boolean().default(true).hidden(),
    latency: Schema.union(['normal', 'balanced']).default('normal').hidden(),
    mp3_bitrate: Schema.union([64, 128, 192]).default(64).hidden()
}).description('fish-audio 讲者')

const QQVoiceSpeaker = Schema.object({
    ...BaseSpeaker,
    characterId: Schema.string().required().description('QQ 声聊角色 id')
}).description('QQ 声聊讲者')

const GsvApiSpeaker = Schema.object({
    ...BaseSpeaker,
    id: Schema.string().required().description(
        '角色 ID（/v1/speakers 返回的 id，不是显示名）'
    ),
    emotion: Schema.string().description('默认情绪，留空用服务端默认'),
    languages: Schema.array(Schema.string())
        .default([])
        .description('支持的语言，如 ZH / EN / JA')
}).description('GSV API 角色')
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
    headers: Schema.dict(Schema.string()).default({}).hidden(),
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
    headers: Schema.dict(Schema.string()).default({}).hidden(),
    config: Schema.object({
        text_split_method: Schema.string().default('cut5'),
        batch_size: Schema.number().default(1),
        batch_threshold: Schema.number().default(0.75).hidden(),
        split_bucket: Schema.boolean().default(true).hidden(),
        speed_factor: Schema.number().default(1),
        fragment_interval: Schema.number().default(0.3).hidden(),
        top_k: Schema.number().default(15),
        top_p: Schema.number().default(1),
        temperature: Schema.number().default(1),
        seed: Schema.number().default(-1).hidden(),
        media_type: Schema.string().default('wav'),
        streaming_mode: Schema.boolean().default(false).hidden(),
        parallel_infer: Schema.boolean().default(true).hidden(),
        use_cuda_graph: Schema.boolean().default(true).hidden(),
        repetition_penalty: Schema.number().default(1.35).hidden(),
        sample_steps: Schema.number().hidden(),
        cfg_rate: Schema.number().hidden(),
        super_sampling: Schema.boolean().default(false).hidden(),
        cut_punc: Schema.string().hidden(),
        speed: Schema.number().hidden(),
        if_sr: Schema.boolean().hidden()
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
    headers: Schema.dict(Schema.string()).default({}).hidden(),
    speakers: Schema.array(FishAudioSpeaker).default([])
}).description('fish-audio')

const QQVoiceBackend = Schema.object({
    type: Schema.const('qq-voice').description('QQ 声聊'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    accountId: Schema.string().description('机器人 QQ 号'),
    speakers: Schema.array(QQVoiceSpeaker).default([])
}).description('QQ 声聊')

const GsvApiBackend = Schema.object({
    type: Schema.const('gsv-api').description('GSV API v1'),
    label: Schema.string().description('展示名'),
    enabled: Schema.boolean().default(true),
    url: Schema.string()
        .required()
        .description('API 地址，如 http://127.0.0.1:9880（不是工作台 9881）'),
    apiKey: Schema.string()
        .role('secret')
        .description('访问密钥；留空表示服务端未开启鉴权'),
    authMode: Schema.union(['bearer', 'x-api-key', 'both'])
        .default('bearer')
        .description('密钥放在 Authorization: Bearer 还是 X-API-Key'),
    format: Schema.union(['wav', 'ogg'])
        .default('wav')
        .description('输出格式；wav 才能多段拼接，ogg 只能分条发'),
    language: Schema.string().description(
        '默认语种（zh/en/ja/yue/ko/auto），留空由服务端按参考音频决定'
    ),
    timeout: Schema.number().description('后端级超时（毫秒）'),
    autoPullSpeaker: Schema.boolean()
        .default(true)
        .description('从 /v1/speakers 自动拉取角色'),
    headers: Schema.dict(Schema.string()).default({}).hidden(),
    speakers: Schema.array(GsvApiSpeaker).default([])
}).description('GSV API v1（/v1/audio/speech）')
export const backendSchema: Schema<Backend> = Schema.union([
    VitsSimpleApiBackend,
    GptSovits2Backend,
    GsvApiBackend,
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
    /** 还没有测速样本时的冷启动超时 */
    coldStart: number
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
    auto: AutoConfig
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
        auto: Schema.object({
            enabled: Schema.boolean()
                .default(false)
                .description('开启后只需填地址与凭证，自动识别后端'),
            url: Schema.string()
                .role('link')
                .description('后端地址：根地址或完整端点（…/voice/vits、…/tts）都行'),
            username: Schema.string().description('Basic Auth 用户名（可选）'),
            password: Schema.string()
                .role('secret')
                .description('Basic Auth 密码（可选）'),
            apiKey: Schema.string()
                .role('secret')
                .hidden()
                .description('X-API-KEY（可选）'),
            token: Schema.string()
                .role('secret')
                .hidden()
                .description('Authorization: Bearer（可选）'),
            backendTimeout: Schema.number()
                .default(0)
                .description('请求超时(ms)，0=自动；后端很慢就填 300000'),
            label: Schema.string().default('自动').hidden(),
            timeout: Schema.number()
                .default(5000)
                .hidden()
                .description('单个探测请求的超时(ms)')
        }).description('只填 url 与凭证，插件自动识别 vits-simple-api / GPT-SoVITS')
    }).description('自动配置（推荐）'),

    Schema.object({
        defaultSpeaker: Schema.dynamic('speaker')
            .default('')
            .description('默认讲者；留空则用第一个（vitsdebug speakers 可查）'),
        backends: Schema.array(backendSchema)
            .default([])
            .description('手动后端列表；开了自动配置且只有一个后端时可以不填'),
        backendsSource: Schema.union(['schema', 'file'])
            .default('schema')
            .hidden()
            .description('后端来源：schema=控制台；file=读 YAML'),
        backendsFile: Schema.string()
            .default('data/local-vitspro/config.yml')
            .hidden()
            .description('file 模式的后端列表路径')
    }).description('基础'),

    Schema.object({
        text: Schema.object({
            stripMarkdown: Schema.boolean()
                .default(true)
                .description('去掉 Markdown 标记'),
            stripEmoji: Schema.boolean()
                .default(true)
                .description('去掉 emoji（后端念不出来）'),
            newlineAs: Schema.union(['space', 'period'])
                .default('space')
                .description('换行转成空格还是句号'),
            blockJoin: Schema.string().default('').hidden(),
            extraTags: Schema.array(Schema.string()).default([]).hidden()
        })
    }).description('文本处理').collapse(),

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
                .description('按哪种标点切片；none=不切'),
            maxSegmentChars: Schema.natural()
                .min(10)
                .default(120)
                .description('单段字数上限'),
            allowFallback: Schema.boolean().default(true).hidden(),
            minSegmentChars: Schema.natural().min(1).default(8).hidden(),
            maxSegments: Schema.natural().min(1).default(8).hidden(),
            concurrency: Schema.natural().min(1).max(8).default(1).hidden()
        })
    }).description('切片').collapse(),

    Schema.object({
        aggregate: Schema.object({
            type: Schema.union(['auto', 'concat', 'multi'])
                .default('auto')
                .description(
                    'auto=能拼就拼；concat=总是拼成一条长语音；multi=切开后分多条发送（指令 -m / -c 可临时覆盖）'
                ),
            maxAudioSeconds: Schema.number()
                .min(1)
                .default(55)
                .description('超过该时长就转文字（QQ 语音约 60s）'),
            partialPolicy: Schema.union(['keep-ok', 'all-or-nothing'])
                .default('keep-ok')
                .hidden()
        })
    }).description('聚合').collapse(),

    Schema.object({
        timeout: Schema.object({
            mode: Schema.union(['auto', 'manual'])
                .default('auto')
                .description('auto=按实测速度算；manual=固定值'),
            manual: Schema.number()
                .default(60000)
                .description('manual 模式下的固定超时(ms)'),
            coldStart: Schema.number()
                .default(60000)
                .description('还没有测速样本时的超时(ms)'),
            factor: Schema.number().default(2).hidden(),
            min: Schema.number().default(5000).hidden(),
            max: Schema.number().default(120000).hidden(),
            overhead: Schema.number().default(800).hidden()
        }),
        breaker: Schema.object({
            mode: Schema.union(['auto', 'manual', 'off'])
                .default('auto')
                .description('auto=退避+半开；manual=固定冷却；off=不熔断'),
            failureThreshold: Schema.natural().min(1).default(2),
            cooldown: Schema.number().default(30000).description('冷却(ms)'),
            maxCooldown: Schema.number().default(600000).hidden(),
            scope: Schema.union(['backend', 'speaker']).default('backend').hidden()
        }),
        notice: Schema.object({
            mode: Schema.union(['off', 'session', 'admin'])
                .default('session')
                .description('降级提示发给谁'),
            interval: Schema.number()
                .default(600000)
                .description('同一原因的最小提示间隔(ms)')
        })
    }).description('超时与熔断').collapse(),

    Schema.object({
        toolCall: Schema.object({
            minChars: Schema.natural()
                .default(2)
                .description('低于该字数不合成（工具调用）'),
            maxChars: Schema.natural()
                .default(300)
                .description('高于该字数不合成（工具调用）')
        }),
        degrade: Schema.object({
            tool: Schema.union(['error', 'text'])
                .default('error')
                .description('工具路径：抛错让调用方兜底'),
            service: Schema.union(['error', 'text'])
                .default('text')
                .description('chatluna 渲染器路径：回文字，避免丢回复'),
            command: Schema.union(['error', 'text'])
                .default('text')
                .description('指令路径')
        }),
        command: Schema.object({
            maxTextChars: Schema.natural().default(2000).hidden()
        })
    }).description('工具调用与降级').collapse(),

    Schema.object({
        bench: Schema.object({
            enabled: Schema.boolean().default(true),
            ladder: Schema.array(Schema.natural().min(1)).default([6, 12, 24]),
            repeat: Schema.natural().min(1).default(2)
        })
    }).description('基准测试').collapse(),

    Schema.object({
        chatlunaTool: Schema.object({
            enabled: Schema.boolean().default(true),
            name: Schema.string().default('vits_say').hidden(),
            sendAudio: Schema.boolean().default(true).hidden(),
            authority: Schema.natural().default(1).hidden()
        })
    }).description('chatluna 工具').collapse()
]) as unknown as Schema<Config>

export const name = 'local-vitspro'









