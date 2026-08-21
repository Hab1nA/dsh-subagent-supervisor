# dsh-subagent-supervisor

面向 DeepSeek Harness 主 Agent 的子代理监督插件（host 平面），附带一个浏览器监督面板。
补齐了官方子代理工具缺失的四个能力（基于 rc.7 验证）：

| 缺口 | 工具 | 机制 |
| --- | --- | --- |
| 1. 按次指定子代理的模型 / 推理设置 | `subagent_run`、`subagent_config` | 通过 `ctx.subagents.startContinuable()` 传按次 `AgentOptions` + `registerContinuableSetup` 安装的按子代理 `agent/request` waterfall（从子代理首个请求起应用 `reasoningEffort` / `temperature` / `maxTokens` / `provider` / `model`，新建与冷恢复都生效） |
| 2. 回合中"插话"投递 | `subagent_send`（模式 `followup` / `inject` / `steer`，可选 `cancel_first`） | `followup` = FIFO 下一回合（支持冷恢复，服务层授权）；`steer` / `inject` = Agent API 的 next-step 队列边界（运行中的子代理在当前回合内的下个 step 边界消费）；`cancel_first` = 先 `subagents.interrupt()`（保留队列） |
| 3. 消息队列管理 | `subagent_queue`（list / remove / clear） | 存活子代理读实时 `Agent.inbox`（经 `agent/inbox/spliced` 持久化）；冷子代理从日志折叠重建 |
| 4. 逐步检查 | `subagent_probe` | 状态 + 生效模型配置（`request/header`）+ 转写窗口（回合/步骤、用户消息、assistant 文本与推理、工具调用与结果、错误）+ pending 队列摘要，读实时会话或持久化日志 |

## 增强能力（v0.2+）

- **① reasoningEffort 适配器预校验** —— `subagent_run` / `subagent_config`
  先解析最终生效路由（参数 > 覆盖 > 父代），在委托前用
  `llm.resolveModelInfo(...).reasoning.efforts` 校验请求的推理档：
  不支持的档位立即报错并列出支持列表，而不是启动一个必然失败的子代理。
  适配器未暴露 efforts 时校验放行（子代理失败仍会经 probe 回显）。
  例如 modlens-opencode-go 暴露 `[off, high, max]`。
- **② 覆盖注册表持久化** —— 注册表存储在
  `$DSH_HOME/subagent-supervisor/overrides.json`（原子 tmp+rename、串行写、尽力而为）。
  插件启动时加载，因此进程重启后冷恢复的子代理自动继承其配置——无需重跑
  `subagent_config`。
- **③ Web 监督面板** —— 会话视图新增"子代理"tab
  （`conversation.view`，order 20）：列出当前会话的直接子代理，选中后可查看
  逐步转写（支持向更早分页）；可发送消息（FIFO followup，走 `api.subagents.prompt`）
  和中断（`api.subagents.interrupt`）。数据源为官方 `api.subagents.*` Remote API
  外加一个插件端点（`/plugins/dsh-subagent-supervisor/children-config`），
  一次请求返回每个子代理**设定的**模型 / 推理强度 / Agent 预设，以三个标签展示在
  每个列表行（与详情头部）——存活子代理报告组合预设真相；冷子代理报告显式覆盖，
  否则报告父代当前预设（即冷恢复实际会继承的预设——绝不再显示裸"继承"标签）。
  端点对持久化目录扫描做了 60 秒缓存（首次约 1s，缓存命中约 1ms；手动"刷新"按钮
  经 `fresh=1` 绕过缓存）。one-shot 子代理只读；面板为会话级（无会话不渲染）。
  steer/inject 保留给模型侧工具（浏览器通道按设计是 human 通道）。
  性能：列表行 memo 化、in-flight 防竞态、按子代理的转写缓存（切换选中即时显示）、
  转写渲染上限 400 行、仅对选中的运行中子代理轮询转写。
- **④ 按子代理指定 Agent 预设** —— `subagent_run {agent_preset: '<id>'}` 用指定
  预设组合子代理（内置 `standard`/`code`/`minimal`/`cordis`，或 `~/.dsh/.agent-presets`
  下的本地预设，如 bohrium-* 角色）。未知或不可用的预设会在子代理启动前失败。
  预设选择随覆盖注册表持久化，重启后冷恢复的子代理自动恢复其预设。机制：子代理
  先继承父代组合，随后按子代理的 `agent/pre-step` 监听器在**首个请求组装
  system/tools 之前**把它 re-link 到目标预设的 standing 组合
  （`agentPresets.recompose`）。孙代继承子代理（re-link 后）的组合。
  `subagent_config` 拒绝运行中改预设（中途换组合会留下新组合无法复现的工具调用日志）。
  已知限制：会话 header 仍记录父代预设 id——运行期组合正确，probe 经 `agent_preset`
  报告真相（仅存活子代理）；只有信任 header 的第三方读取可能显示旧预设。
- **⑤ 结算闭环** —— 三层保障，让已完成的子代理绝不会让父代理茫然等待：
  - `subagent_wait {subagent_ids, timeout_seconds?, require?}` 在当前回合内等待
    子代理结算，返回每个子代理的终态（冷子代理从日志提取 `stopReason`，如崩溃后的
    `interrupted`）与最终输出。本进程已结算的子代理立即返回；冷子代理从持久化日志
    判定终态（有排队工作或回合未结束的子代理会报错并提示先唤醒）；超时返回已结算
    子集并带 `timed_out: true`。
  - `subagent_probe` 新增 `settlement` 字段（`stopReason`/`at`/`summary`/
    `closingText`），由 `subagent/end` 喂养的进程内注册表支撑——即使结算通知本身
    丢失（父代未加载、父代回合被中断清掉 pending steering、投递异常），父代理也能
    随时**查询**"它完成了吗、说了什么"。
  - 卡住检测（Config：`stallMinutes` 默认 15，`stallReminder` 默认 true）：
    超过阈值无新会话事件的运行中子代理，会向其存活父代理注入一条节流提醒。
  - 本部署观察到的环境注意：长时间工具执行（包括 `subagent_wait` 的实时等待）
    可能被环境级自动重启打断。建议使用短超时 + 重查，或依赖 idle 时的结算通知
    （idle 父代经 followup 可靠唤醒）+ probe 验证。

## 安装

将 pnpm 指向克隆下来的源码（按你的克隆路径调整）：

```powershell
pnpm --dir $env:DSH_HOME\profiles\web add file:<本仓库路径>
```

挂载到 **host 平面**：`$env:DSH_HOME\profiles\web\cordis.patch.yml`
（该行绝不能放在 preset 内：`registerContinuableSetup` 是进程单例，
每个 preset 一份会让每个子代理被安装两次）：

```yaml
- insert:
    - id: subagent-supervisor
      name: dsh-subagent-supervisor
```

客户端部分经包内的 `dsh.client` 声明自动发现，服务端
`/plugins/dsh-subagent-supervisor/client.js`；浏览器刷新页面后生效。

> **注意**：`pnpm add file:` 会**拷贝**包（hoisted linker）。修改源码后需重跑
> `pnpm add` 重新同步副本，然后重启 harness。

> **已修复（v0.2.1）**：`subagent_wait` 曾在超时/监听器清理中调用 `ctx.off(...)` ——
> cordis 只暴露带 disposer 的 `ctx.on`、没有 `ctx.off`，超时回调抛出的 TypeError
> 成为 `uncaughtException`，**杀死了整个 DSH 进程**（即"服务挂掉"现象）。
> 实时等待现改用全局 waiter 表（由插件唯一的 `subagent/end` 监听器统一喂给），
> 不再动态注册监听器；所有清理回调均已异常包裹。
> continuable 子代理的 setup disposer 也做了同样的修复。

重启 harness。验证：`dsh --profile web --dump-config` 出现该行，
主 Agent 工具目录出现 6 个 `subagent_*` 工具，刷新页面后会话视图出现"子代理"tab。

## 工具

- **subagent_run** `{description, prompt, provider?, model?, maxTokens?, reasoningEffort?, temperature?, agent_preset?}`
  → 以给定路由和（可选）Agent 预设启动 continuable 子代理；
  返回 `{subagentId, messageId, applied}`。未提供的字段继承父代路由/预设。
- **subagent_send** `{subagent_id, message, mode?: followup|inject|steer, cancel_first?: boolean}`
  → 仅返回投递确认（绝不是子代理的回答）。**默认模式为 `steer`**
  （插话式：运行中的子代理在当前回合内消费）；未指定模式且子代理不在内存时，
  投递自动降级为 `followup`（冷恢复保持可用；返回的 `mode` 报告实际采用的模式）。
  `steer` 无法打断正在执行的模型请求或工具调用（架构限制）；
  "长单步"场景请组合 `cancel_first: true`。
- **subagent_queue** `{subagent_id, action: list|remove|clear, message_id?}`
  → `remove`/`clear` 需要存活子代理；`list` 对冷子代理同样可用。
- **subagent_probe** `{subagent_id, limit?, since_turn?, include_reasoning?, max_chars?}`
  → 状态、生效配置、实际预设、结算记录、转写窗口、pending 队列摘要。冷子代理可用。
- **subagent_config** `{subagent_id, provider?, model?, maxTokens?, reasoningEffort?, temperature?}`
  → 运行中覆盖更新；从子代理的下一个模型请求起生效。
- **subagent_wait** `{subagent_ids, timeout_seconds?, require?: all|any, max_chars?}`
  → 在当前回合内等待子代理结算；返回每个子代理的
  `{stopReason, summary, closingText?}` 以及 `timed_out`。三分支语义与环境注意见 ⑤。

## 语义与限制

- **授权**：每个监督工具都校验调用者在目标的持久祖先链内
  （`sessionQuery.traceSession`），与 continuation manager 的 `interrupt` 规则一致。
  followup 委托服务层自身的授权路径。
- **覆盖生命周期**：注册表持久化到
  `$DSH_HOME/subagent-supervisor/overrides.json` 并在启动时重放，因此后续回合
  与重启后冷恢复的子代理都保留其配置（模型路由、推理、预设）。适配器归一化
  可能胜出（如 provider 可能解析自己的 `maxTokens` 默认）——probe 的
  `effective_config` 显示日志实际记录的配置。
- **steer 时序**：在当前回合内子代理的下一个 step 边界消费。被拒绝的 step
  会把 steering 留在队列直到下次唤醒；取消或销毁可能丢弃 pending steering
  （核心 `Agent.steer` 语义）。
- **冷子代理**：`followup` 与 `probe`/`list`/`wait` 可用；
  `inject`/`steer`/队列变更需要存活子代理。
- **结算注册表**：仅进程内（`subagent/end` 喂养，FIFO 200）；
  进程重启后 probe 的 `settlement` 字段在下次结算前为空——转写尾部
  （`turn N end: <reason>`）仍是持久兜底，`subagent_wait` 会从日志重新判定冷子代理。
- **卡住检测**：默认 `stallMinutes: 15`、`stallReminder: true`；
  可在 `cordis.patch.yml` 的插件行 config 中覆盖。

## 开发

- 纯函数（`clip`、`textOfBlocks`、`textLengthOf`、`mergeOverrides`、
  `foldPendingInbox`、`queueRowOf`、`selectEventWindow`、`definedOnly`、
  `validateEffortAgainstModelInfo`、`resolveEffectiveRoute`、
  `parseOverridesFile`、`serializeOverridesFile`、`resolveOverridesFilePath`、
  `classifySettlement`、`terminalReasonOf`、`finalOutputOf`、`settlementSummaryOf`、
  `trimSettled`、`registerWaiter`、`resolveWaiters`、`buildChildrenConfig`、
  `mergeColdChildren`、`resolveSendMode`、`resolveColdPreset`）已导出供测试：
  harness 根目录运行 `node --test plugins/dsh-subagent-supervisor/test/`。
- 回滚：移除 insert 行并 `pnpm --dir ... remove dsh-subagent-supervisor`，
  然后重启（`~/.dsh/undo` 下的配置快照覆盖 `cordis.patch.yml`）。
