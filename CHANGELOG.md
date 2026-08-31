# Changelog

本仓库遵循语义化版本（SemVer）。Release 说明以中文撰写。

## [v0.5.0] - 2026-08-31

### 跨版本自动兼容（本次核心变更）

- **支持 DSH 核心 `0.1.1-rc.2` / `0.1.2-alpha.1` / `0.1.2-alpha.2` 三条版本线**。
  peer 依赖统一声明为 `>=0.1.1-rc.2 <0.2.0 || >=0.1.2-alpha.1 <0.2.0`，
  经 npm 官方 semver 实测覆盖三个目标版本并排除 0.2.x。
- 新增 `lib/compat.js`：核心版本代际分类（`rc2` / `alpha`）、客户端能力表、
  模块形态探测与核心版本探测；启动日志打印
  `core <版本> (generation rc2|alpha)`。
- **web 面板引导守卫**（`lib/client.js`）：rc.2 线行为完全不变；
  alpha 线（客户端运行时 `dsh-client-runtime` 改名 `dsh-client-modules`、
  ApiProxy 网关移除）自动跳过面板并打印一条告警，
  不再有导致页面崩溃的风险；host 平面 6 个工具始终可用。
- 新增 `test/compat.test.mjs`（已纳入 `npm test`）：peer 范围契约、
  代际分类、能力表、模块探测、三种客户端注入面下的面板注册/降级行为。

### 其他

- README：更新版本叙述（原"基于 rc.7 验证"），新增「兼容性」章节。
- `package.json` 新增 `npm test` 脚本。

## [v0.4.0]

- `subagent_run` 路由预校验；覆盖生效状态上报（`applied`/`effective_config`）。

## [v0.3.1]

- 会话级继承快照与生效值标签；冷子代理 steer 自动降级为 followup。

## [v0.3.0]

- 首版发布：`subagent_run` / `subagent_send` / `subagent_queue` /
  `subagent_probe` / `subagent_config` / `subagent_wait` + web 监督面板。

## [v0.2.1]

- 修复 `subagent_wait` 超时/监听器清理路径中 `ctx.off(...)` 引发的
  进程级崩溃（改由全局 waiter 表统一喂给，清理回调全部异常包裹）。