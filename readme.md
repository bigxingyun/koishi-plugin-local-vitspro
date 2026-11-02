# koishi-plugin-local-vitspro

[![npm](https://img.shields.io/npm/v/koishi-plugin-local-vitspro)](https://www.npmjs.com/package/koishi-plugin-local-vitspro)
[![downloads](https://img.shields.io/npm/dm/koishi-plugin-local-vitspro)](https://www.npmjs.com/package/koishi-plugin-local-vitspro)
[![license](https://img.shields.io/npm/l/koishi-plugin-local-vitspro)](https://github.com/bigxingyun/koishi-plugin-local-vitspro/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/bigxingyun/koishi-plugin-local-vitspro)](https://github.com/bigxingyun/koishi-plugin-local-vitspro)

Koishi 的多后端 TTS 聚合插件。把 `vits-simple-api`、`GPT-SoVITS（v2 / v1）`、`fish-audio`、`QQ 声聊` 收进同一个 `vits` 服务，供 [chatluna](https://github.com/ChatLunaLab/chatluna)、[chatluna-character](https://github.com/ChatLunaLab/chatluna-character) 直接调用。

它重点解决三件事：

- **长句不被序列化格式切碎**——chatluna 传来的 `<message><voice>…</voice></message>` 会被解包成纯文本，整段合成；
- **超时按后端真实速度算**——用基准测速拟合「字数 → 耗时」，不同后端、不同文本长度给不同预算，而不是拍一个固定 60 秒；
- **后端抽风时快速降级**——有限退避 + 半开探测，降级有提示、可查状态，不会把 bot 卡住。

## 工作机制

### 1. 输入归一化

```
<output><message quote="123"><voice id="1">今天天气不错…</voice></message></output>
        │  解包容器 / 反转义 / 去 Markdown / 去元素 / 去 emoji
        ▼
今天天气不错…
```

`<voice id>` 会作为讲者提示；二次序列化的 `&lt;message&gt;` 也能还原。

### 2. 长文本切片

整段不超过 `split.maxSegmentChars`（默认 120）就不切；超过才在窗口内找**最后一个句末标点**切开：

- 支持 `zh_period`（中文句号）/ `zh_comma`（中文逗号）/ `en_period`（英文句号）/ `en_comma`（英文逗号）/ `none`（不切）；
- 引号、括号、URL、小数、英文缩写内部不切；
- 过短的段并入相邻段，段数超过上限时合并尾段。

### 3. 音频聚合

多段合成后，若都是**同参数 PCM WAV**，直接拼接成一条语音；参数不一致（或 mp3 等格式）时降级为多段发送，首段作为回复、其余用 `session.send()` 补发。

### 4. 自适应超时

`vitsbench` 按长度阶梯（默认 6 / 12 / 24 字）实测后端，最小二乘拟合：

```
估算耗时 = a + b × 字数
超时     = clamp(overhead + factor × 估算耗时, min, max)
```

拟合结果写回内存，下一条消息立即生效。也可以用 `timeout.mode = manual` 固定超时，两者是并列模式。

还没有样本的前 3 次调用会用 `timeout.coldStart`（默认 60s），避免「后端第一次加载模型慢」被误判成超时。机器特别慢（比如 CPU 跑 GPT-SoVITS，实测单句几十秒到两分钟）时，直接在对应后端写 `timeout: 300000` 覆盖，最稳。

### 5. 熔断与降级

每个后端一份状态机：连续失败到阈值进入 `open`，冷却后只放一个探测请求（`half-open`），成功即恢复。

- `AUTH`（401/403）一次即永久熔断，`vitsdebug on` 或改配置才恢复；
- `BAD_REQUEST`（400/422）不熔断，只降级并记日志；
- 降级提示按原因 10 分钟节流；
- 工具路径（chatluna-character）抛 `VitsDegradeError` 让调用方用解析好的文字兜底；服务路径（chatluna 渲染器）直接回纯文本，避免整条回复被 `middleware_error` 吃掉。

## 安装

在 Koishi 控制台的「插件市场」搜索 `local-vitspro` 安装，或：

```bash
npm i koishi-plugin-local-vitspro
```

升级：

```bash
npm update koishi-plugin-local-vitspro
```

### 自动配置（推荐）

只填 URL 与凭证，插件自己探测后端类型与协议：

```yaml
plugins:
  local-vitspro:
    auto:
      enabled: true
      url: http://127.0.0.1:48572   # 根地址 / …/voice/vits / …/tts 都行
      username: user              # Basic Auth（没有就留空）
      password: 你的密码
      # apiKey: xxx                     # 用 X-API-KEY 的后端
      # token: xxx                      # 用 Authorization: Bearer 的后端
      # backendTimeout: 300000          # 后端很慢（CPU 推理）时直接写死请求超时
```

探测顺序（全部是无副作用的 GET）：`/voice/speakers` → `/openapi.json` → `/tts` → `/`。

- **vits-simple-api**：识别后自动拉讲者，真正做到「只填 URL」；
- **GPT-SoVITS v2 / v1**：能识别出版本，但它没有讲者列表接口，仍需在手动后端里为讲者配置 `ref_audio_path`（参考音频是服务端路径，无法猜）；
- 探测结果缓存 60s；`vitsdebug` 能看到结论，`vitsdebug probe` 会逐步打印每个探测请求的 URL / 状态码 / 耗时。

自动与手动可以并存：同类型同地址的手动后端存在时，自动结果不会重复添加。

拉到讲者后，控制台「基础 → defaultSpeaker」会变成**下拉框**，直接选当前可用的讲者即可（`vitsdebug speakers` 里也能看到完整 key）。讲者新增/变化时会自动刷新这个下拉。

### 手动配置

想精确控制就走手动，字段完全显式：

```yaml
plugins:
  local-vitspro:
    defaultSpeaker: 测试_ZH
    backends:
      - type: vits-simple-api
        label: 本地
        url: http://127.0.0.1:23456
        autoPullSpeaker: true
        speakers:
          - name: 测试
            id: 0
            type: VITS
            languages: [ZH]
```

`url` 填根地址即可；填完整的合成端点（如 `…/voice/vits`）或带尾部 `/voice` 也会自动还原。后端很慢时加 `timeout: 300000`（毫秒）覆盖动态超时。

配好后发 `vitsdebug speakers` 确认讲者，再发 `vitsbench` 让超时模型吃到真实速度。

`type` 可以省略：缺少时按字段推断（有 `url` → vits-simple-api；有 `ref_audio_path` / `gpt_weights` / `apiVersion` → GPT-SoVITS；`accountId` → QQ 声聊；`reference_id` → fish-audio）。推断结果会写进日志，`vitsdebug` 里能看到；无法推断或缺少必填字段的条目会被跳过并说明原因，不会再出现「静默 0 个讲者」。

## 支持的后端

| 后端 | 必填 | 说明 |
| --- | --- | --- |
| `vits-simple-api` | `url` | 支持 `X-API-KEY`、HTTP Basic Auth、自动拉取讲者（`/voice/speakers`） |
| `GPT-SoVITS2` | `url` + 讲者 `ref_audio_path` | 同时支持 `api_v2.py`（`/tts`）与老版 `api.py`（`/`），可切换 GPT / SoVITS 底模 |
| `fish-audio` | `apiKey` | 云端服务，按 `reference_id` 选音色 |
| `qq-voice` | `accountId` | QQ 声聊，仅群聊，依赖 OneBot |

讲者条目可以写任意额外参数（`noise`、`noise_w`、`length`、`sdp_ratio`、`preset`、`prompt_text`、`speed` 等），会透传给对应后端。

### GPT-SoVITS 配置

GPT-SoVITS 没有「讲者列表」接口，讲者就是一组参考音频配置。`ref_audio_path` 必须是**后端机器上的路径**，不是你本地的。

```yaml
- type: GPT-SoVITS2
  label: 丛雨
  url: http://127.0.0.1:9880
  apiVersion: v2          # v2=api_v2.py（默认）；v1=老版 api.py
  method: auto            # auto=先 POST，405/404 回退 GET；也可 get / post
  config:                 # 全局默认请求参数，讲者里可覆盖
    text_split_method: cut5
    batch_size: 1
    top_k: 15
    top_p: 1
    temperature: 1
  speakers:
    - name: 丛雨
      ref_audio_path: audio/mur001_062.ogg   # 服务端路径
      aux_ref_audio_paths: []
      prompt_text: ほれ、吾輩の言った通りであろう？
      prompt_lang: ja
      text_lang: zh
      gpt_weights: GPT_SoVITS/pretrained_models/xxx.ckpt   # 可选，切换底模
      sovits_weights: SoVITS_weights_v2/xxx.pth            # 可选
      languages: [ZH, EN, JA]   # 可选：按语言生成多个讲者 key（丛雨_ZH、丛雨_EN…）
```

对得上官方 `api_v2.py` 的参数：`top_k` / `top_p` / `temperature` / `text_split_method` / `batch_size` / `batch_threshold` / `split_bucket` / `speed_factor` / `fragment_interval` / `seed` / `media_type` / `streaming_mode` / `parallel_infer` / `repetition_penalty` / `sample_steps` / `cfg_rate` / `super_sampling` / `use_cuda_graph`，默认值与官方一致。

几个容易踩的点：

- 失败时官方返回 **HTTP 400 + JSON**（`message` / `Exception`），插件会把这段内容拼进错误信息，方便直接定位；
- `media_type: raw` 没有音频头，无法与其他段拼接，建议用 `wav`；
- 老版 `api.py`（`apiVersion: v1`）的参数名是 `refer_wav_path` / `prompt_language` / `text_language` / `inp_refs` / `speed`，插件会自动映射，且 **v1 没有底模切换接口**，`gpt_weights` / `sovits_weights` 会被忽略；
- 如果是 vits-simple-api，它自带 `/voice/speakers`，不需要手写讲者。

## 指令

| 指令 | 说明 | 权限 |
| --- | --- | --- |
| `vitspro <text>` | 合成语音，`-s` 指定讲者 | 1 |
| `vitsbench [backend]` | 基准测速并写回超时模型，`-n` 次数、`-s` 讲者、`-r` 清样本、`-f` 清熔断 | 3 |
| `vitsdebug` | 状态：后端、讲者数、拟合参数、熔断、建议超时 | 3 |
| `vitsdebug on` / `vitsdebug off` | 开启并清熔断 / 临时关闭语音 | 3 |
| `vitsdebug speakers` | 讲者列表（含 `id`），会强制重新拉取 | 3 |
| `vitsdebug reload` | 立即重新拉取讲者列表 | 3 |
| `vitsdebug probe [backend]` | 诊断讲者拉取：打印最终 URL、状态码、耗时、原始错误与建议 | 3 |
| `vitsdebug text <text>` | 打印归一化、切片、决策与超时，不发请求 | 3 |
| `vitsdebug reset [backend]` | 清空测速样本与熔断状态 | 3 |

> 0.1.5 起不再注册 `tts` / `lunavits`：旧插件 `koishi-plugin-local-vits` 用的是这两个名字，同时装会冲突。升级后用 `vitspro` / `vitsdebug` / `vitsbench`。

## 与 chatluna 配合

插件实现了 `@initencounter/vits` 的 `vits` 服务，chatluna 与 chatluna-character 不需要改动，直接选 `voice` / `mixed-voice` 渲染模式即可。

另外可选注册 chatluna 工具 `vits_say`（`chatlunaTool.enabled`），让模型主动把某句话变成语音。依赖全部是可选 peer + 动态 `import`，没装 chatluna 也能正常加载。

## 常见问题

**后端比 Koishi 启动慢，讲者列表空着**

不会。拉取失败会标记为「未拉全」并后台按 5s → 9s → 16s… 退避重试，最长 2 分钟一次；拉到即停，最多一分钟后还会自动刷新。也可以手动 `vitsdebug reload`。

**还是拉不到讲者，是不是协议不对**

先发 `vitsdebug probe`，它会打印最终请求的 URL、状态码、耗时和原始错误。对照看：

| probe 显示 | 多半是 |
| --- | --- |
| `404` | `url` 写成了 `…/voice`（会自动纠正一次）或多了别的路径；也可能这个后端不是 vits-simple-api |
| `401 / 403` | `apiKey` 或 `username`/`password` 不对 |
| `CONNECT` | 后端没起、端口不对、防火墙拦了 |
| `TIMEOUT` | 后端在加载模型，等一会儿再 `vitsdebug reload` |
| `成功 · 0 个` | 接口通了但后端没加载模型，`/voice/speakers` 本身是空的 |
| `未请求` | 该后端 `autoPullSpeaker=false`，只能用配置里的 `speakers` |

正常返回长这样：`{"VITS":[{"id":0,"name":"派蒙","lang":["zh"]}], "HUBERT-VITS":[…], "BERT-VITS2":[…], "GPT-SOVITS":[…]}`，本插件也兼容数组、`{data:[…]}`、`{speakers:[…]}` 这几种写法。

**没声音 / 只有文字**

先发 `vitsdebug` 看后端状态与熔断；`AUTH` 熔断检查账密或 API Key；再用 `vitsdebug text <文本>` 看决策与超时。降级时会有一次中文提示（可关）。

**一句长话变成了好几条语音**

说明 WAV 参数不一致、走了多段降级。确认后端都返回同采样率 WAV，或把 `aggregate.type` 设为 `concat` 观察日志。

**想用旧插件的配置**

不支持迁移，也不读取旧路径。直接在控制台按上面的示例配一遍，或把后端列表写成 YAML 并设 `backendsSource: file`。

## 来源

本项目改自 [SilverWolfHoney/koishi-plugin-local-vits](https://github.com/SilverWolfHoney/koishi-plugin-local-vits)——它是 [ChatLunaLab/luna-vits](https://github.com/ChatLunaLab/luna-vits) 的本地化改版，多后端抽象、适配器思路与指令设计都来自上游，感谢原作者。

## License

[MIT](./LICENSE)





