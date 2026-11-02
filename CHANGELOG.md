# Changelog

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



