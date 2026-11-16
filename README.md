# pi-codex 0.2.6

在 pi-agent 的插件页面添加本目录 `F:/pi-codex`，启用后新建会话或使用 GUI 的 Reload 操作。

[GitHub Releases](https://github.com/ODtian/pi-codex/releases) 提供 npm 格式的 `odtian-pi-codex-0.2.6.tgz`。包名为 `@odtian/pi-codex`。

Fast 使用请求参数 `service_tier: "priority"`，模型 ID 使用真实值。现有 GUI 的 `/codex` 对话框或 `/codex fast on|off` 修改当前会话模型的 `samplingParams.service_tier`。原生 profile 的 `model` 留空时继承父会话模型及其请求参数，指定模型时采用该模型配置。子会话可以用同一命令单独切换。profile 通过原生扩展配置加载本包：

```yaml
load_extensions: true
extensions: [pi-codex]
```

输入 `/codex` 打开 `ctx.ui.custom()` 设置面板。↑/↓ 移动，Enter/空格切换，选择“保存并关闭”应用；Esc 取消。`/codex fast` 等命令直接定位对应行。GUI 提供命令名补全，Pi CLI 还提供参数补全。面板和以下命令共用设置入口：

```text
/codex fast on
/codex fast off
/codex review on
/codex compaction remote
/codex compaction experimental
```

Fast、审查开关和上下文策略保存在当前会话，`config.json` 控制插件初始值。模型配置中的 `samplingParams.service_tier` 提供 Fast 默认值。

| 上下文策略 | 实现 | 恢复方式 |
| --- | --- | --- |
| `remote` | SDK Codex provider 发送 `compaction_trigger`，服务端生成加密 checkpoint | 保存于 `compaction.details`，随新消息重放 |
| `experimental` | 本地安装新上下文窗口 | `notes` 保存任务状态，`history` 恢复原始会话，`new_context` 在工具批次结束后切窗并继续 |

两种策略都接入 GUI 压缩按钮和自动压缩。实验性策略由 Pi 的本地分支提供历史与笔记存储，切窗产生零次摘要请求。后续推理使用选中的模型。

自动审查使用 `openai-codex/codex-auto-review`、官方 policy 和完整 allow/deny 判定。`policy.md` 可编辑，每次审查读取；`review.serviceTier: "priority"` 为审查请求选择 Fast。默认 `low` effort、Responses Lite 和输出契约按官方审查调用对齐。[模型选择](https://github.com/openai/codex/blob/f1ebc7b372bc837b7c6386113e867256d7cc7036/codex-rs/ext/guardian-reviewer/src/model.rs)、[输出契约](https://github.com/openai/codex/blob/f1ebc7b372bc837b7c6386113e867256d7cc7036/codex-rs/ext/guardian-reviewer/src/assessment.rs)

审查连接在进程内复用，并通过 `generate:false` 预热。同批动作并发预审，每个动作等待自己的完整结果。本机样本：旧版冷连接 3.61 秒、复用连接 2.43 秒；对齐后的 Fast 复用连接约 1.40 秒；预热后的双动作批次约 2.37 秒，第二个工具检查等待约 1 毫秒。主要耗时来自网络与服务端推理/输出。[预热协议](https://developers.openai.com/api/docs/guides/websocket-mode#connect-and-create-responses)

消融验证保留了审批结果和并发请求数，并将双层调度收敛为一个共享队列。已授权读取与未授权关机的审查样例分别得到 allow 和 deny。关机样例仅提交给审查入口。

实验性上下文管理依据 Codex 的[新窗口生命周期](https://github.com/openai/codex/blob/f1ebc7b372bc837b7c6386113e867256d7cc7036/codex-rs/core/src/compact_token_budget.rs)。许可证与官方材料归属见 NOTICE。
