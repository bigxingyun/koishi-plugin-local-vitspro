/** 输入来源：决定降级策略与阈值 */
export type Source = 'tool' | 'service' | 'command'

/** 降级方式：抛错让调用方兜底，或直接回纯文本 */
export type DegradeAction = 'error' | 'text'

/** 切片模式：4 种分隔符 + 不切 */
export type SplitMode =
    | 'none'
    | 'zh_period'
    | 'zh_comma'
    | 'en_period'
    | 'en_comma'

export type AggregateType = 'auto' | 'concat' | 'multi'
export type PartialPolicy = 'keep-ok' | 'all-or-nothing'
export type TimeoutMode = 'auto' | 'manual'
export type BreakerMode = 'auto' | 'manual' | 'off'
export type BreakerScope = 'backend' | 'speaker'
export type NoticeMode = 'off' | 'session' | 'admin'

/** 降级原因码：既用于日志，也用于用户提示与错误对象 */
export type DegradeCode =
    | 'EMPTY_TEXT'
    | 'TOO_SHORT'
    | 'TOO_LONG'
    | 'CIRCUIT_OPEN'
    | 'DISABLED'
    | 'TIMEOUT'
    | 'BACKEND_ERROR'
    | 'NO_SPEAKER'
    | 'ALL_SEGMENTS_FAILED'

/** HTTP 错误的语义分类 */
export type ErrorClass =
    | 'CONNECT'
    | 'TIMEOUT'
    | 'AUTH'
    | 'SERVER'
    | 'EMPTY'
    | 'BAD_REQUEST'

// ---------------------------------------------------------------------------
// 后端与讲者
// ---------------------------------------------------------------------------

export interface SpeakerBase {
    name: string
    /** 该讲者支持的语言（大写，如 ZH / EN / JA / AUTO） */
    languages?: string[]
    [key: string]: unknown
}

export interface BackendBase {
    /** 展示名，用于日志与 `vitsbench` 过滤 */
    label?: string
    enabled?: boolean
    /** 后端级超时覆盖（毫秒），优先级高于全局 timeout */
    timeout?: number
    headers?: Record<string, string>
    speakers?: SpeakerBase[]
    autoPullSpeaker?: boolean
}

export interface VitsSimpleApiBackend extends BackendBase {
    type: 'vits-simple-api'
    url: string
    apiKey?: string
    username?: string
    password?: string
}

export interface GptSovits2Params {
    /** v2: /tts；v1: /（老版 api.py，参数名不同） */
    apiVersion?: 'v2' | 'v1'
    /** auto=先 POST，405/404 时回退 GET；也可强制 get / post */
    method?: 'auto' | 'get' | 'post'
    text_split_method?: string
    batch_size?: number
    batch_threshold?: number
    split_bucket?: boolean
    speed_factor?: number
    fragment_interval?: number
    top_k?: number
    top_p?: number
    temperature?: number
    seed?: number
    media_type?: string
    streaming_mode?: boolean | number
    parallel_infer?: boolean
    repetition_penalty?: number
    sample_steps?: number
    cfg_rate?: number
    super_sampling?: boolean
    use_cuda_graph?: boolean
    /** v1 专用 */
    cut_punc?: string
    speed?: number
    if_sr?: boolean
    /** v2 流式参数 */
    overlap_length?: number
    min_chunk_length?: number
    gpt_streaming?: boolean
    streaming_chunk_seconds?: number
    streaming_window_mode?: string
}

export interface GptSovits2Backend extends BackendBase {
    type: 'GPT-SoVITS2'
    url: string
    /** v2=api_v2.py（/tts）；v1=老版 api.py（/） */
    apiVersion?: 'v2' | 'v1'
    /** auto=先 POST，405/404 时回退 GET */
    method?: 'auto' | 'get' | 'post'
    config?: GptSovits2Params
}

/** GSV 工作台自带的 v1 公开 API：角色/情绪由服务端管理 */
export interface GsvApiSpeaker extends SpeakerBase {
    /** /v1/speakers 返回的角色 id，调用 speech 时用它而不是显示名 */
    id?: string
    emotions?: string[]
    defaultEmotion?: string
    status?: string
}

export interface GsvApiBackend extends BackendBase {
    type: 'gsv-api'
    /** 例如 http://127.0.0.1:9880 */
    url: string
    apiKey?: string
    /** 密钥放哪个头：bearer / x-api-key / both */
    authMode?: 'bearer' | 'x-api-key' | 'both'
    /** 输出格式：wav 可拼接；ogg 不能拼 */
    format?: 'wav' | 'ogg'
    /** 默认语种，留空由服务端按参考音频决定 */
    language?: string
}

export interface FishAudioBackend extends BackendBase {
    type: 'fish-audio'
    /** 默认 https://api.fish.audio */
    baseUrl?: string
    apiKey?: string
}

export interface QQVoiceBackend extends BackendBase {
    type: 'qq-voice'
    accountId?: string | number
}

export type Backend =
    | VitsSimpleApiBackend
    | GptSovits2Backend
    | GsvApiBackend
    | FishAudioBackend
    | QQVoiceBackend

/** 扁平化后的讲者条目：`tts speakers` 与 speaker_id 映射都基于它 */
export interface VoiceEntry {
    /** 稳定 id，从 1 开始；0 表示“用默认讲者” */
    id: number
    /** 完整 key，例如 银狼/丛雨_ZH */
    key: string
    /** 讲者名 */
    name: string
    /** 语言（大写），可能为空 */
    language?: string
    /** 后端展示名 */
    backendLabel: string
    backend: Backend
    speaker: SpeakerBase
}

// ---------------------------------------------------------------------------
// 合成结果
// ---------------------------------------------------------------------------

export interface AudioResult {
    /** PCM WAV 或其他格式的原始字节 */
    data: Buffer
    /** MIME 或短格式名（wav / mp3 / flac），用于 h.audio 与聚合判断 */
    mime: string
    /** true 表示适配器已自行发送（如 QQ 声聊），调用方不要再发 */
    sent?: boolean
}

export interface SayOptions {
    input: string
    speaker_id?: number
    /** koishi Session，可选（vits 服务契约里没有，靠 Object.assign 注入） */
    session?: any
    /** 内部覆盖来源识别结果 */
    source?: Source
    /** 覆盖多条/拼接的发送方式 */
    aggregate?: AggregateMode
}

export interface SynthesizeOptions {
    speaker?: string
    session?: any
    source?: Source
    /** 覆盖配置里的 aggregate.type（指令 -m / -c 用） */
    aggregate?: AggregateMode
}

/** 多段音频的发送方式：auto=能拼就拼；concat=强制拼接；multi=发多条 */
export type AggregateMode = 'auto' | 'concat' | 'multi'

/** 极简 http 客户端契约：koishi ctx.http 兼容，测试可注入 stub */
export interface HttpClient {
    post(
        url: string,
        data?: any,
        config?: Record<string, any>
    ): Promise<any>
    get(url: string, config?: Record<string, any>): Promise<any>
}

export interface LoggerLike {
    debug(...args: any[]): void
    info(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
}

export interface ChatlunaToolConfig {
    enabled: boolean
    name: string
    sendAudio: boolean
    authority: number
}

/** 自动配置：只填 URL 与凭证，协议/后端类型靠探测 */
export interface AutoConfig {
    enabled: boolean
    url: string
    label: string
    username: string
    password: string
    apiKey: string
    token: string
    /** 探测请求超时（毫秒） */
    timeout: number
    /** 自动后端的请求超时（毫秒），0 表示用动态/冷启动 */
    backendTimeout: number
}

/** 熔断配置（Breaker 的构造参数，也出现在 Config 里） */
export interface BreakerConfig {
    mode: BreakerMode
    scope: BreakerScope
    failureThreshold: number
    cooldown: number
    maxCooldown: number
}



