# Changelog

## 0.1.9 (2026-11-02)

- 讲者列表注册为控制台动态选项：拉到讲者后「基础 → defaultSpeaker」会变成下拉框，可直接选择，不用手抄 key。
- 讲者变化（自动刷新、后端新增、切换后端）会同步刷新这个下拉；当前配置值也会并入选项，避免旧值保存时报校验错误。
- 测试：189 个用例、16 项冒烟（新增「讲者注册为动态选项」断言）。

## 0.1.8 (2026-11-02)

- 配置健壮性：`backends[].type` 缺失或写错时按字段推断（url / ref_audio_path / accountId / reference_id），并补齐 `enabled` / `speakers` 默认值；推断与跳过原因写日志，`vitsdebug` 可查。
- 不再静默跳过：未知 `type` 会告警并指出后端名，缺少 `url` / `apiKey` 的条目会被剔除并说明原因，避免「0 个讲者且无报错」。
- 设置界面精简：自动配置置顶；高级分组默认折叠；低频参数（headers、GPT 采样参数、fish 细节等）隐藏但仍可通过 YAML 配置；描述改成一句话。
- 测试：188 个用例、15 项冒烟（新增 `tests/backend-config.test.ts`，含「漏写 type」复现用例）。

## 0.1.7 (2026-11-02)

- 自动配置新增 `auto.backendTimeout`：慢机器（CPU 推理，单句几十秒）可以直接写死请求超时，避免自动模式没有 `backends[].timeout` 可用。
- 自动探测失败会自动重试（10s 间隔），后端恢复后无需重启即可补上。
- 测试：174 个用例、14 项冒烟。

## 0.1.6 (2026-11-02)

- 新增**自动配置**：只需填 `auto.url` + 可选凭证，插件按 `/voice/speakers` → `/openapi.json` → `/tts` → `/` 的顺序探测协议，自动识别 `vits-simple-api`、GPT-SoVITS v2 / v1，并自动拉取 vits-simple-api 的讲者。
- 自动与手动配置并存（同类型同地址去重）；`vitsdebug` 展示自动探测结论，`vitsdebug probe` 逐步打印探测请求。
- 凭证支持 HTTP Basic、`X-API-KEY`、`Authorization: Bearer`。
- 测试：173 个用例、14 项冒烟（新增 `tests/detect.test.ts`）。

## 0.1.5 (2026-11-02)

- 修复 onebot 编码器崩溃（`Cannot read properties of undefined (reading 'trimEnd')`）：不再返回空的 text 元素；空文本（`EMPTY_TEXT`）统一抛 `VitsDegradeError`，由调用方兜底。
- 命令重构，避免与旧插件重名：**移除 `tts` 与 `lunavits`**，新增一级指令 **`vitsdebug`**（状态 / on / off / speakers / reload / probe / text / reset），`vitspro` 与 `vitsbench` 保持不变。
- 测试：153 个用例、13 项冒烟。

## 0.1.4 (2026-11-02)

- 真机联调发现的问题修复：`url` 可以直接填完整合成端点（`…/voice/vits`、`…/voice/bert-vits2`、`…/tts`），插件会自动还原成根地址，不再拼成 `…/voice/vits/voice/speakers`。
- 冷启动超时：前 3 次调用用 `timeout.coldStart`（默认 60s），避免后端首次加载模型慢被误杀；慢机器可用 `backends[].timeout` 进一步覆盖。
- 切片并发默认从 2 降到 1：单后端/慢机器上并行请求会排队并互相拖到超时，需要速度再调到 2。
- 测试：152 个用例（新增完整端点归一化、冷启动预算、样本足够后切回公式）。

## 0.1.3 (2026-11-02)

- GPT-SoVITS 完整适配：`api_v2.py` 的 `/tts` 支持 GET / POST / auto 回退；补齐官方全部常用参数（`fragment_interval` / `parallel_infer` / `repetition_penalty` / `sample_steps` / `cfg_rate` / `super_sampling` / `use_cuda_graph` 等），默认值与官方一致。
- 新增老版 `api.py` 支持（`apiVersion: v1`）：自动映射 `refer_wav_path` / `prompt_language` / `text_language` / `inp_refs` / `speed`，且不会调用不存在的底模切换接口。
- 必填字段前置校验（`ref_audio_path` / `prompt_lang` / `text_lang`），缺字段直接报参数错误，不再把无效请求打给后端。
- 解析官方 400 的 JSON 错误体（`message` / `Exception`）并拼进错误信息；`auto` 模式仅在 405/404/501 时回退另一种 HTTP 方法。
- 讲者支持 `languages`（按语言生成多个 key）与 `speed` 旧写法；`top_k` 默认值对齐官方 15。
- 测试：148 个用例、13 项冒烟（新增 `tests/gpt-sovits.test.ts`）。

## 0.1.2 (2026-11-02)

- 讲者拉取排障：新增 `tts probe`，打印最终 URL、状态码、耗时、原始错误与可操作提示。
- `url` 容错：自动去掉尾部斜杠与误填的 `/voice`，避免拼成 `/voice/voice/speakers`。
- `/voice/speakers` 响应容错：兼容数组、`{data:[…]}`、`{speakers:[…]}`、以 id 为键的对象、`lang` 为字符串等写法；仍然跳过 `HUBERT-VITS`。
- 拉取失败时错误信息带上 URL / 状态 / 响应片段；没有自动拉取能力的后端（如 GPT-SoVITS2）讲者为空时不再无限重试。
- 测试：136 个用例、12 项冒烟。

## 0.1.1 (2026-11-02)

- 文档：重写 README，聚焦「插件做什么 / 机制怎么转 / 怎么安装与配置 / 常见问题」，补 npm 与 GitHub 徽章，末尾标注改自 `SilverWolfHoney/koishi-plugin-local-vits`。代码无改动。

## 0.1.0 (2026-11-02)

首个可自用版本，按 `开发计划.md` v1.2 实现。

### 修复

- **后端比 Koishi 启动慢时讲者列表拿不到**：拉取失败不再被吞掉、空列表不再被当成加载成功；新增后台指数退避重试（5s 起、封顶 2 分钟）、60s TTL 自动刷新、真实消息时的强制补拉、`tts reload` 手动补拉；重载插件也会重新拉取。
- **序列化输入被当成正文**：解包 `<output>` / `<message>` / `<voice>`，反转义 `&lt;` 等实体，去 Markdown / 元素 / emoji，长句不再被标签切碎；`<voice id>` 同时作为讲者提示。
- **熔断不合理**：删除「首次失败永久熔断」，改为每后端状态机（连续失败阈值 / 退避 / 半开探测 / `AUTH` 永久熔断 / `BAD_REQUEST` 不熔断），并按文本长度自适应超时；增加中文降级提示（默认 10 分钟节流）。
- **长文本直接推理**：插件层切片（`none` / `zh_period` / `zh_comma` / `en_period` / `en_comma`），WAV 同参拼接为一条语音，无法拼接时降级多段发送。

### 新增

- `vitsbench` 顶层指令：长度阶梯基准测速，最小二乘拟合 `a + b × 字数` 并写回超时模型（权限 `authority: 3`，与上游 `tts` 一致）。
- `tts` 状态 / `tts on` / `tts off` / `tts speakers` / `tts reload` / `tts debug` / `tts reset`。
- `vitspro` 指令（别名 `lunavits`）。
- 可选 chatluna 工具 `vits_say`（未安装 chatluna 时自动跳过）。
- 后端：`vits-simple-api`、`GPT-SoVITS v2`、`fish-audio`、`QQ 声聊`。
- 文件模式（`backendsSource: file`，默认 `data/local-vitspro/config.yml`，热更新）。
- 117 个单元 / 功能测试（stub HTTP 校验请求格式与聚合），11 项构建产物冒烟测试。

### 已知限制

- 未对真实 TTS 后端联调（开发环境无后端），请求格式按上游实现与各后端 API 对齐；
- 不支持 gradio 后端；
- 不支持自动翻译。
















