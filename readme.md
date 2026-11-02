# koishi-plugin-local-vitspro

> 仓库：[github.com/bigxingyun/koishi-plugin-local-vitspro](https://github.com/bigxingyun/koishi-plugin-local-vitspro) · 问题反馈：[Issues](https://github.com/bigxingyun/koishi-plugin-local-vitspro/issues)

多后端 TTS 聚合插件，针对 [koishi-plugin-local-vits](https://github.com/SilverWolfHoney/koishi-plugin-local-vits)（luna-vits 的本地化改版）的三个已知问题重写：

1. **序列化格式被当成正文**：chatluna / chatluna-character 传进来的 `<message><voice>…</voice></message>` 会被正确解包，长句能整条出语音；
2. **熔断不合理**：按「后端实测推理速度 × 本次文本长度」计算超时，失败后有限退避 + 半开探测，每次降级都有提示；
3. **长文本直接推理**：插件层切片（中文逗号 / 中文句号 / 英文逗号 / 英文句号 / 不切），再把音频拼回一条。

支持后端：`vits-simple-api`、`GPT-SoVITS v2`（`/tts` API）、`fish-audio`、`QQ 声聊`。gradio 暂不支持。

一句话简介：让 chatluna 的长回复能整条念出来，并且在后端抽风时快速降级而不是把 bot 卡住。

## 安装

```bash
npm i koishi-plugin-local-vitspro
```

在 `koishi.yml` 里启用：

```yaml
plugins:
  local-vitspro:
    defaultSpeaker: 测试_ZH
    backends:
      - type: vits-simple-api
        label: 本地
        url: http://127.0.0.1:23456
        speakers:
          - name: 测试
            id: 0
            type: VITS
            languages: [ZH]
```

插件实现 `@initencounter/vits` 的 `vits` 服务，chatluna 与 chatluna-character 不需要改任何配置。

## 配置

配置全部是 Koishi Schema，控制台里可以直接改。几个关键点：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `defaultSpeaker` | 空 | 不指定讲者时用谁；`tts speakers` 可查完整 key |
| `backends[]` | `[]` | 后端列表，`type` 决定字段（见下） |
| `split.mode` | `zh_period` | 切片模式：`none` / `zh_period` / `zh_comma` / `en_period` / `en_comma` |
| `split.maxSegmentChars` | `120` | 单段上限；整段文本低于该值时不会切 |
| `aggregate.type` | `auto` | `auto` 能拼就拼（WAV 同参数），否则多段发送 |
| `timeout.mode` | `auto` | `auto` 按测速模型算超时；`manual` 用固定 `timeout.manual` |
| `breaker.mode` | `auto` | `auto` 退避 + 半开；`manual` 固定冷却；`off` 永不熔断 |
| `degrade.tool` | `error` | 工具路径（character）降级时抛错，让它用解析好的文字兜底 |
| `degrade.service` | `text` | chatluna 渲染器路径降级时回文字（抛错会丢掉整条回复） |
| `toolCall.minChars` / `maxChars` | `2` / `300` | 工具调用低于/高于该字数不合成 |

**后端字段速查**

| 后端 | 必填 | 常用 |
| --- | --- | --- |
| `vits-simple-api` | `url` | `apiKey`（X-API-KEY）、`username`/`password`（Basic Auth）、`autoPullSpeaker` |
| `GPT-SoVITS2` | `url` | `config.*` 全局请求参数；讲者里可写 `gpt_weights`/`sovits_weights`/`ref_audio_path`/`prompt_text` |
| `fish-audio` | `apiKey` | `baseUrl`、讲者 `reference_id` |
| `qq-voice` | `accountId` | 讲者 `characterId`；只能群聊，走 OneBot |

讲者条目允许写任意额外字段：vits-simple-api 的 `noise` / `noise_w` / `length` / `sdp_ratio` / `preset` / `prompt_lang` / `reference_audio`，GPT-SoVITS 的 `speed` / `top_k` / `temperature` 等都会被透传。

### 文件模式

后端多、想直接改文本时，可以设 `backendsSource: file`，插件会读 `backendsFile`（默认 `data/local-vitspro/config.yml`）并在文件变化后热更新。文件结构就是 `backends[]` 的 YAML 数组。

> 文件模式只读自己的路径，**不会**读取旧插件（luna-vits / local-vits）的 `data/local-vits/`，也不提供旧配置迁移。

## 启动顺序（后端比 Koishi 启动慢）

TTS 后端经常比 Koishi 晚几十秒才监听端口，所以：

- 插件加载时会拉一次讲者；**拉不到不会把空列表当成成功**，而是标记为「未拉全」；
- 之后按 5s → 9s → 16s… 指数退避在后台重试，最长 2 分钟一次，拉到即停；
- 讲者列表还有 60s 的 TTL：后端新增了讲者，最多一分钟后自动生效；
- 真实消息进来时如果还没有讲者，会先强制刷新一次（5s 冷却），仍拿不到才降级为文字；
- 手动补拉：`tts reload` / `tts speakers`（`authority: 3`）。

日志里会看到 `讲者列表还没拉全（TTS 后端可能尚未启动），N 秒后重试`，后端起来后变成 `讲者列表已就绪：N 个`。

## 指令

| 指令 | 说明 | 权限 |
| --- | --- | --- |
| `vitspro <text>`（别名 `lunavits`） | 合成语音，`-s <讲者名或 id>` | 1 |
| `vitsbench [backend]` | 基准测速，`-n` 每档次数、`-s` 讲者、`-r` 清样本、`-f` 清熔断 | 3 |
| `tts` | 状态：后端、讲者数、拟合参数、熔断、建议超时 | 3 |
| `tts on` / `tts off` / `tts 开` / `tts 关` | 开启并清熔断 / 临时关闭语音 | 3 |
| `tts speakers` | 讲者列表（含 `id`），会强制重新拉取 | 3 |
| `tts reload` | 立即重新拉取讲者列表（后端刚启动时用） | 3 |
| `tts debug <text>` | 打印归一化、切片、决策与超时，**不发请求** | 3 |
| `tts reset [backend]` | 清空测速样本与熔断状态 | 3 |

## 测速与熔断

`vitsbench` 会按 `bench.ladder`（默认 6 / 12 / 24 字）逐档合成，取中位耗时，再用最小二乘拟合：

```text
估算耗时 = a + b × 字数
超时     = clamp(overhead + factor × 估算耗时, min, max)
```

拟合结果写回内存，**下一条真实消息立刻生效**。`ttsbench` 的报告长这样：

```text
基准测试：1 个后端，每档 2 次取中位
· 本地
　6 字：1.2s（成功 2 次）
　12 字：1.7s（成功 2 次）
　24 字：2.8s（成功 2 次）
　拟合：a=720ms b=83.0ms/字 · 样本 6 · 建议超时(60字) 10.7s · closed
```

熔断是每后端（可选每讲者）一个状态机：

- 连续 `failureThreshold` 次失败 → 熔断，冷却后只放一个半开探测；
- `AUTH`（401/403）一次即永久熔断，`tts on` 或改配置才恢复；
- `BAD_REQUEST`（400/422）不熔断，只降级；
- 降级时按 `notice.interval`（默认 10 分钟）给一次中文提示。

## 切片与聚合

- 整段文本 ≤ `split.maxSegmentChars` 时不切；超过才按标点在窗口内找最后一句切开；
- 引号 / 括号 / URL / 小数 / 英文缩写内部不切；
- 过短的段并入相邻段，段数超过 `split.maxSegments` 时合并尾段；
- 多段音频：WAV 且参数（编码/声道/采样率/位深）一致才拼接，否则 `aggregate.type=auto` 降级为多段发送（`multi` 时首段作为返回值，其余用 `session.send` 补发）。

## 与 chatluna / chatluna-character 配合

- **工具调用路径**（character 的输出 / `character_reply` 工具）：输入里带 `<message>` / `<voice>` 标记时一律按工具路径处理；
- 越界（太短 / 太长）或熔断时按 `degrade.tool` 处理，默认抛 `VitsDegradeError`（带 `code` 与已归一化的 `text`）。character 会用它解析好的文字元素兜底，所以用户看到的仍是干净文字；
- **chatluna 核心渲染器路径**（`outputMode = voice`）：没有标记、带 `session`，走 `degrade.service`，默认回纯文本——因为这条路径抛错会被 chatluna 的 `_handleMiddlewareError` 接住并替换成 `middleware_error`，整条回复会丢；
- 可选注册 chatluna 工具 `vits_say`（`chatlunaTool.enabled`）：装了 `koishi-plugin-chatluna` 才会注册，依赖全部动态 `import`，没装不影响加载。

## 已知限制

- 开发环境没有真实 TTS 后端：单元测试与冒烟测试用 **stub HTTP** 校验请求格式（URL / 表单字段 / JSON 字段 / 鉴权头）与音频聚合，**未对着真实后端做联调**，第一次接真后端时建议先跑 `vitsbench`；
- gradio 后端暂不支持（需要时会单开一个里程碑）；
- 不做自动翻译（旧插件的 `autoTranslate` 未迁移）；
- 不做音频转码：只拼 PCM WAV，mp3 等格式走多段发送；
- QQ 声聊依赖 OneBot 的 `send_group_ai_record`，私有实现差异较大。

## 开发

```bash
npm i
npm run typecheck   # tsc --noEmit
npm run test        # vitest（117 个用例，纯 Node，不需要 koishi 运行时）
npm run smoke       # 构建产物 + 真实 koishi Context 冒烟（11 项）
npm run verify      # 以上三个一起跑
```

> `smoke` 走 CJS：koishi 4.18 的 ESM 产物在 Node 24 下加载会因 loader 的 default 互操作失败，而 koishi 实际加载插件用的就是 CJS。

## License

MIT


