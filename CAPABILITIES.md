# dsh-subagent-supervisor 能力说明

> 版本：0.2.0+（含 agent_preset 增强）
> 位置：`plugins/dsh-subagent-supervisor/`（本仓库）
> 挂载：`$env:DSH_HOME\profiles\web\cordis.patch.yml`（host 平面行 `subagent-supervisor`）
> 目标运行时：DeepSeek Harness 0.1.0-rc.7（web profile）

## 一、插件定位

给主 Agent（以及任何有子代理的 Agent）提供对 **continuable 子代理** 的完整控制闭环：
**按次指定配置 → 受控启动 → 插话/队列管理 → 逐步探测 → 运行中调整**，全部零核心包改动，
并配套一个浏览器监督面板。子代理获得的能力与主 Agent 完全互补：主 Agent 管，子代理做。

## 二、能力总览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 带配置委托 | `subagent_run` | 按次指定 provider/model/maxTokens/reasoningEffort/temperature/agent_preset |
| 三种消息投递 | `subagent_send` | followup（FIFO 下一回合）/ inject（补上下文不唤醒）/ steer（当前回合内下个 step 边界消费），可选 cancel_first |
| 队列管理 | `subagent_queue` | list / remove / clear 子代理 pending 消息（next-turn + next-step） |
| 逐步探测 | `subagent_probe` | 状态 / 实际组合预设 / 生效模型配置 / 逐步转写（含推理、工具调用、错误）/ 队列摘要 |
| 运行中改配置 | `subagent_config` | provider/model/maxTokens/reasoningEffort/temperature（预设除外） |
| 推理档预校验 | `subagent_run`/`subagent_config` 内置 | 适配器不支持的 effort 在启动前报错并列出支持档 |
| 覆盖持久化 | 内置 | `$DSH_HOME/subagent-supervisor/overrides.json`，重启后自动重放 |
| 子代理自定义预设 | `subagent_run {agent_preset}` | standard/code/minimal/cordis 或用户自定义角色预设 |
| Web 监督面板 | 浏览器"子代理"tab | 子代理列表、转写查看、发消息、中断 |

## 三、模型侧工具（主 Agent 可直接调用）

### 1. subagent_run —— 带配置启动子代理

```
subagent_run {
  description: string        # 必填，3-5 词任务描述
  prompt: string             # 必填，自包含任务说明（子代理看不到主对话）
  provider?: string          # 可选，覆盖 provider 路由
  model?: string             # 可选，覆盖模型
  maxTokens?: number         # 可选，每次请求输出上限
  reasoningEffort?: string   # 可选，推理强度（适配器相关，如 off/high/max）
  temperature?: number       # 可选，采样温度
  agent_preset?: string      # 可选，子代理的 Agent 预设 id
}
→ { kind: 'continuable', subagentId, messageId, applied }
```

行为：
- 创建 **continuable** 子代理（默认后台运行），返回持久子代理 id；结算时主 Agent 收到通知。
- 未提供的字段继承父代（provider/model/maxTokens 走 `resolveChildAgentOptions` 继承链）。
- `reasoningEffort` 会在启动前对**最终生效路由**做适配器预校验（`llm.resolveModelInfo`），
  不支持则立即报错并列出支持档（例如 modlens-opencode-go 暴露 `[off, high, max]`）。
- `agent_preset` 在启动前校验存在性与可挂载性（未知预设报错并列出全部可用预设）；
  运行期通过 `agent/pre-step` re-link 到目标预设组合，首个请求即生效。
- 配置写入覆盖注册表并持久化。

### 2. subagent_send —— 三种投递模式

```
subagent_send { subagent_id, message, mode?: followup|inject|steer, cancel_first?: boolean }
→ { mode, messageId, cancelled, note }
```

- **followup**（默认）：排队为子代理的下一回合（FIFO）。子代理正在工作时消息等待当前回合结束；
  冷子代理自动冷恢复后消费。与官方 `send_message` 行为一致。
- **steer**：投递到子代理的 next-step 队列并唤醒——**运行中的子代理在下一 step 边界、当前回合内**消费，
  可重定向进行中的任务。无法打断正在执行的单次模型请求或工具调用（架构限制）。
- **inject**：同 next-step 队列但不唤醒，作为下一 pre-step 的补充上下文。
- **cancel_first: true**：先请求中断子代理当前活动（保留队列），中断收敛后消息继续执行——
  用于"当前回合极长、需要立即重定向"的场景。
- 返回仅投递确认，不代表已读/已完成；失败即未投递。

### 3. subagent_queue —— 消息队列管理

```
subagent_queue { subagent_id, action: list|remove|clear, message_id? }
```

- **list**：返回 next-turn 与 next-step 的 pending 消息（id + 文本预览 + 序号）。
  存活子代理读实时 inbox；冷子代理从持久化日志（`agent/inbox/spliced`）重建。
- **remove**：按 message_id 删除一条 pending 消息（仅存活子代理；已被回合认领的不可删）。
- **clear**：清空全部 pending（next-turn + next-step），**不打断**当前活动。
- 所有变更持久化为子代理自己的 `agent/inbox/spliced` 事件，重启后可重建。

### 4. subagent_probe —— 逐步探测

```
subagent_probe { subagent_id, limit?, since_turn?, include_reasoning?, max_chars? }
→ { subagent_id, status, resident, agent_preset?, effective_config?, transcript, pending_summary }
```

- **status**：running / idle / ready；**resident**：是否加载在内存。
- **agent_preset**：live 时实测子代理实际组合预设（`composedPreset`），非 header 记录值。
- **effective_config**：最近一次 `request/header` 的生效配置（provider/model/reasoningEffort/temperature/maxTokens）。
- **transcript**：逐步转写窗口——回合/步骤边界、用户消息（含 steer/inject）、assistant 文本、
  推理内容（默认折叠为字数，`include_reasoning` 展开）、工具调用与结果、错误详情
  （如 `provider X model Y does not support reasoning effort "medium"`）。
- 冷子代理同样可读（持久化日志）；噪声事件（流式 chunk 等）不计入窗口预算。

### 5. subagent_config —— 运行中改配置

```
subagent_config { subagent_id, provider?, model?, maxTokens?, reasoningEffort?, temperature? }
→ { subagent_id, applied, note }
```

- 更新覆盖注册表，从子代理**下一个模型请求**起生效（`agent/request` waterfall + 请求头重记录）。
- 仅非空字段生效，未提供字段保持原值；变更持久化。
- **拒绝 `agent_preset`**：预设只能在创建时指定（中途换组合会留下新组合无法复现的工具调用日志）。

## 四、Web 监督面板（浏览器）

- 入口：会话视图顶部视图环新增 **"子代理"** tab（`conversation.view`，id `subagent-supervisor`）。
- 数据通道：官方 Remote API（`api.subagents.list / history / prompt / interrupt`），无需自定义 host 路由。
- 能力：
  - 列出**当前会话的直接子代理**（label / 状态徽章 running·inactive / 模式 continuable·one-shot / 是否有后代）；
  - 选中子代理查看逐步转写（按 seq 升序，reasoning 字数摘要，工具调用/结果/错误行），可"加载更早"分页；
  - continuable 子代理：发送消息（FIFO followup，与模型侧 followup 同语义）、中断按钮；
  - one-shot 子代理只读；running 项 5s 轮询刷新。
- 边界：会话级（未选会话不渲染）；无 steer/inject 按钮（浏览器通道是 human 通道，steer/inject 保留给模型侧工具）。

## 五、核心机制

### 1. 覆盖注册表（overrides registry）
- 进程内 `Map<childId, entry>`，entry 字段：provider / model / maxTokens / reasoningEffort / temperature / agentPreset。
- 每个 **continuable 子代理**（创建与冷恢复）都会安装作用域监听器（`registerContinuableSetup`）：
  - `agent/request` waterfall：按注册表应用配置覆盖（scope 过滤，只影响该子代理，首个请求即生效）；
  - `agent/pre-step`：若注册表指定 `agentPreset`，在组装 system/tools **之前** `agentPresets.recompose`
    re-link 到目标预设的 standing composition（闭包内 Set 防重复；冷恢复时 contribution 重装、重新恢复预设）。

### 2. 持久化
- 文件：`$DSH_HOME/subagent-supervisor/overrides.json`（`{version:1, entries:{...}}`，每条含 updatedAt）。
- 启动时加载（损坏降级为空并告警）；每次变更异步串行原子写（tmp + rename），best-effort。
- 效果：子代理的模型路由、推理参数、预设选择在**进程重启后自动重放**，冷恢复无需重发配置。

### 3. 谱系授权
- 所有监督操作先校验调用者位于目标的持久祖先链（`sessionQuery.traceSession`），与 continuation
  manager 的 interrupt 授权同规则；非后代调用一律 UNAUTHORIZED。
- followup 模式直接委托服务层授权路径（含冷恢复）；steer/inject/队列变更要求存活子代理。

### 4. 预校验
- 推理档：按"参数 > 覆盖 > 父代"解析最终路由后对适配器 efforts 精确匹配；无法解析时 pass-through。
- 预设：`resolve`（存在性）+ `standingKeyFor`（可挂载性 + 预组合）双检查，fail fast。

## 六、错误与降级行为

| 场景 | 行为 |
| --- | --- |
| 适配器不支持 reasoningEffort | 工具报错 `does not support reasoning effort "X"; supported: [...]`，不启动/不改配置 |
| 未知 / 不可用预设 | 工具报错并列出可用预设，不启动 |
| 冷子代理用 steer/inject/队列变更 | 报错提示改用 followup（支持冷恢复）或等待激活 |
| 非后代 id | UNAUTHORIZED 拒绝 |
| 覆盖文件损坏 | 降级空注册表 + 日志告警，不阻断启动；下次变更重写 |
| 目标预设被删除后冷恢复 | re-link 失败仅告警，子代理以继承预设恢复 |
| 单步超长 | steer 等待 step 边界（架构限制）；`cancel_first:true` 组合可立即重定向 |
| 运行中改预设 | subagent_config 明确拒绝 |

## 七、已知限制

- **steer 无法打断 in-flight 的模型请求或工具执行**——只能等 step 边界；打断用 interrupt / cancel_first。
- **会话 header 的 agentPreset 仍记录父代预设**：运行期组合正确（probe 显示实测值），仅第三方按
  header 渲染的展示路径可能显示旧预设（插件层过渡方案的代价；正式支持建议向 deepseek-ai 提 issue：
  `SubagentStartRequest.agentPreset`）。
- 覆盖注册表与预设选择是**进程级**语义（持久化后重启可重放，但换机器/换 DSH_HOME 不迁移）。
- Web 面板仅显示直接子代理（无 descendants 深树）、无队列编辑、无 steer/inject（human 通道设计）。
- 无并发/配额限制（可后续增加 maxConcurrentPerParent 类控制）。

## 八、验证记录

- 单元测试：`node --test plugins/dsh-subagent-supervisor/test/helpers.test.mjs` → **16/16 通过**
  （clip / textOfBlocks / textLengthOf / mergeOverrides / foldPendingInbox / queueRowOf /
  selectEventWindow / definedOnly / validateEffortAgainstModelInfo / resolveEffectiveRoute /
  parseOverridesFile / serializeOverridesFile / resolveOverridesFilePath / agentPreset 往返）。
- 端到端（真实子代理运行）：
  - 配置生效：`subagent_run {reasoningEffort:'high', temperature, maxTokens}` → probe effective_config 全部落地；
    `subagent_config` 运行中修改 → 下一请求生效（probe 确认）。
  - steer 同回合插话：`user [coordinator]` 消息在 turn 内 step 边界被消费；
    `cancel_first:true` → `turn end: aborted (cause=parent)` → 新指令执行（答案 15 ✓）。
  - 队列：3 条 followup 列出 → remove 1 → clear 2，均生效且持久化。
  - 冷恢复：重启后 followup → 上下文完整（5117/19016/24133 记忆保留）、覆盖自动重放。
  - 预设：`agent_preset:'code'` → probe 实测 `agent_preset:'code'`；重启冷恢复后仍为 `code`。
  - 未授权：非后代会话 probe → UNAUTHORIZED。
  - 失败模式：`reasoningEffort:'medium'`（适配器不支持）→ 启动前报错，无子代理产生。
