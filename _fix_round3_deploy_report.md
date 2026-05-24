# Finance-Auto Fix-Round-3 · Deploy / UI Sibling Report

> **Sibling**: Z (deploy / docs / UI)
> **Branch**: `revamp/v3-orgs`
> **Range**: `acf015a9..HEAD` (parent: round 2 closing commit)
> **Scope**: EX-P1-4, EX-P1-5, EX-P2-1, EX-P2-9, EX-P2-11, EX-P2-12,
>   EX-P2-13 (docs-only), EX-P2-14 (UI side)
> **Sibling α (backend)**: EX-P1-1, EX-P1-2 (RBAC), EX-P1-3, EX-P2-7 —
>   3 of α's commits landed inside my window, no path collisions.
> **Status**: 7 / 7 self-audit checks green; `check_territory.py` → 0 errors.

## §0 摘要 + self-audit

| 自审项 | 结果 |
| :-- | :--: |
| c1 `run_all_acceptance` 10/10 (existing JSON) | ✅ |
| c2 README internal links resolve (9 / 9) | ✅ |
| c3 `plugin.json` parses + `version == 1.0.0-rc1` | ✅ |
| c4 `requirements.txt` lex-parses + `pip install --dry-run` clean | ✅ |
| c5 Docker docs + Dockerfile build-arg + compose validity | ✅ |
| c6 WS reconnect contract sentinels (10 / 10) | ✅ |
| c7 `check_territory.py acf015a9..HEAD` exit 0 | ✅ |

Result JSON: `_fix_round3_self_audit_result.json` (7/7 ok).
Mock WS probe: `_fix_round3_ws_reconnect_probe.py` (15/15 ok).

## §1 EX-P1-4 README rewrite — `ea357b0f`

`plugins/finance-auto/README.md` 由 41 行 "M1 W1 skeleton" 改为 344 行
v1.0 RC 部署指南。10 节：功能简介 / 系统要求 / 安装 / 5 步快速上手 /
14 功能矩阵 / 安全说明（含 v1 / v2 路径约定 EX-P2-13 文档化）/
3 种部署模式 / 12 条 Known Limitations / 5 条 FAQ / License。

诚实的 Known Limitations 段明确列出 EX-P1-1 / EX-P1-2 / EX-P1-3 的
deferral，避免外部扫描时 surprise。

## §2 EX-P1-5 5 依赖声明 — `2d5ba958` + `3bb2d45e`

3 个协同变更：
1. **新建** `plugins/finance-auto/requirements.txt` —— 6 个 runtime
   deps（openpyxl / xlrd==1.2.0 / xltpl / keyring / pywin32 marker /
   cryptography），含注释解释每个 pin 的理由。
2. **更新** `plugins/finance-auto/plugin.json` —— version `0.1.0` →
   `1.0.0-rc1`，加 `python_dependencies` / `min_python_version` /
   `python_dependencies_file`，扩展 permissions 列表（file.read /
   file.write / keyring / native.dialog / websocket.serve）。
3. **扩展** 根 `pyproject.toml` `[project.optional-dependencies]` 加
   `finance-auto` extra，将来用户可 `pip install openakita[finance-auto]`。

`3bb2d45e` 修正两个 self-audit 发现：
- `xltpl>=0.30` 写错（PyPI HEAD = 0.21），改 `>=0.20,<1.0`。
- `requirements.txt` 含 U+2500 box-drawing → cn-Windows GBK locale
  下 pip auto_decode 失败；改纯 ASCII + 加 NOTE 防止回退。

## §3 EX-P2-1 CI workflow — `000805ba`

新增 `.github/workflows/finance-auto-ci.yml`，4 个 job：

- `lint`：ruff check on plugin python sources（5 分钟超时）。
- `tests`：pytest `plugins/finance-auto/tests/`，注入临时
  `OPENAKITA_FINANCE_AUTO_PASSPHRASE` 让 ubuntu-latest 无 D-Bus 环
  境也能跑。
- `acceptance`：`scripts/run_all_acceptance.py` 一键回放 10 个套件，
  产物上传为 14 天 artifact。
- `dependency-audit`：`pip-audit -r requirements.txt`，
  `continue-on-error: true` 防止新 CVE 阻断 PR；JSON 上传为
  artifact 供 reviewer 决定是否 bump pin。

paths 过滤只在 `plugins/finance-auto/**` 或 workflow 自身变更时跑，
避免每次主仓库改都触发。

## §4 EX-P2-11 Docker 部署文档 — `912cffe2`

新增 `plugins/finance-auto/docs/DEPLOY_DOCKER.md`（190 行 / 6 节）：
TL;DR 强调 `OPENAKITA_FINANCE_AUTO_PASSPHRASE` 必填 → `docker run`
单机示例 → `docker-compose.yml` 模板（healthcheck pin 到插件
`/health`、env_file 分离 secret） → 2 种 deps 安装路径（pyproject
extra preferred / 显式 requirements.txt） → 5 条 Q&A → 8 项生产
checklist → 交叉引用。

同时给根 `Dockerfile` 加 build arg `INSTALL_FINANCE_AUTO`（默认 0），
开启时走 `pip install ".[finance-auto]"`。默认行为完全保持，避免
影响其他用户。

> **本机未跑通**：Windows 工作站无 Docker daemon；通过 `docker
> compose config` 校验 yaml 合法即可，build/run 由用户机器验证。
> Dockerfile 改动是 1 个 ARG + 1 个 if-else RUN，足够小风险。

## §5 EX-P2-14 WebSocket 重连 + cursor（UI 部分）— `6c355e5a`

`plugins/finance-auto/ui/dist/index.html` 单文件，3 处协同改造：

- **状态机规范化为 4 态**：`init` → `connecting` → `connected` →
  `(reconnecting → connecting …)` → `closed`。之前混用 "open"/
  "closed"，UI 无 reconnecting 信号。
- **Exp backoff**：1 s → 2 s → 4 s → 8 s → 16 s → 32 s（上限 32 s），
  `retry` 在 onopen 重置；reconnecting 事件携带 `retry` + `delay_ms`
  供 badge 渲染倒计时。
- **Cursor**：每条消息带 `message_id` 时更新本地 `lastSeenId`；
  重连时 URL 追加 `?since=<id>`。后端 α 加 `message_id` 后即生效；
  无 `message_id` 时静默退化（行为与重构前一致）。
- **Singleton hub** `_wsHub`：保证 AIConsentBridge + WSConnBadge 共用
  一条 socket。`useFinanceWS` / `useFinanceWSStatus` 都基于 hub。
- **WSConnBadge 组件**：TopBar 右侧灰/绿/黄/红 4 色实时显示，带
  `data-ws-state` + `data-ws-cursor` 给 E2E 测试用。

WS 重连 mock 验证：`_fix_round3_ws_reconnect_probe.py`，
15 / 15 静态契约检查通过（状态枚举 / backoff 公式 / cursor URL /
singleton 唯一性 / badge data-attrs）。

## §6 EX-P2-9 Reclassification undo（UI 部分）— `6c355e5a`

同 commit 里在 `ReclassificationView` 历史 Run 表格加 "操作" 列。每
个 `apply` 模式 run，若在 24 h 内且未 undone，显示 "撤销" 按钮 →
弹模态确认框列出 `items_count` + `total_amount` → 确认后调
`POST /orgs/{org_id}/reclassification-runs/{run_id}/undo`。响应 3 路
都有处理：

- 200 → 成功 toast + 刷新
- 404 → "暂未上线（v1.0 GA 计划中）" warn（**α undo endpoint 尚未
  上线**，前端已优雅降级）
- 409 → "状态已变更，请刷新" warn

已 undone 的 run 显示灰色 "已撤销" badge + 撤销时间戳 tooltip。

## §7 EX-P2-12 openapi-typescript 生成器 — `5d83e0c5`

新增 `plugins/finance-auto/ui/scripts/gen-types.mjs`（独立 Node 20+
脚本）+ `plugins/finance-auto/ui/package.json`（dev-only deps，
`openapi-typescript ^7.4` + `typescript ^5.4`）。脚本拉本机
`/openapi.json` → 过滤 `/api/plugins/finance-auto/*` 路径 →
openapi-typescript v7 生成 → 写 `ui/dist/types/finance-auto-api.d.ts`
（带 banner）。

最小参数解析，无额外 deps；后端不在 / 包未装时 fail loudly 给
operator-friendly 提示。**未挂 CI**（按 brief，v1.0.x backlog）；
README §10.1 引导前端开发者按需运行。

## §8 EX-P2-13 v1 API 版本化（文档化，不动路由）— 已在 §1 README §6 覆盖

按 brief 明确**不动前端 fetch URL**避免与 α 冲突；README §6.4 文档
化 v1.0 RC API 路径约定 + 给出 v1.x→v2 升级建议（参考 host 的
`orgs_v2_legacy_redirects.py` 308 兼容 pattern）。

## §9 Self-audit 全表

| # | 检查项 | 结果 | 证据 |
| :-: | :-- | :--: | :-- |
| c1 | `_finance_auto_run_all_acceptance.json` 10 / 10 (α 上次跑) | ✅ | scripts_passed=10, scripts_failed=0 |
| c2 | README 9 internal links | ✅ | missing=[] |
| c3 | `plugin.json` valid + version `1.0.0-rc1` + 6 python_deps | ✅ | json.load OK |
| c4 | `requirements.txt` 6 specs lex-parse + pip dry-run clean | ✅ | `Would install cryptography-45.0.7` 唯一变化 |
| c5 | `DEPLOY_DOCKER.md` (8597 bytes) + Dockerfile arg + `docker compose config` rc=0 | ✅ | 全部 sentinel 命中 |
| c6 | UI WS contract 10 sentinels（state / backoff / cursor / hub / badge） | ✅ | 10/10 命中 |
| c7 | `check_territory.py acf015a9..HEAD` exit 0 | ✅ | 10 commits → 6 clean + 4 warn + 0 error |

辅助脚本：`_fix_round3_self_audit.py` (7 checks),
`_fix_round3_ws_reconnect_probe.py` (15 contract assertions).

## §10 与 Sibling α 协调

α 在我 window 内 push 了 3 个 commit（`eb2dd49e` /
`a8628d1f` / `083189d3`），分别完成 EX-P1-1（备份路径沙盒）、
EX-P1-3（PBKDF2 600 k）、EX-P2-7（半文件 cleanup）。

**路径冲突**：零。α 全在
`plugins/finance-auto/finance_auto_backend/**` +
`plugins/finance-auto/tests/**`，与我的 territory 完全互补。

**API 同步**：α 尚未上线 reclassification undo endpoint；我的 UI
按 brief 优雅降级（404 → warn toast "暂未上线，v1.0 GA 计划中"）。
α 完成后无需再改前端。

**version sync**：我 bump 了 `plugin.json` 到 `1.0.0-rc1`，与 α 的
EX-P1-3 的 KDF 升级一并标 v1.0 RC，无 race。

## §11 遗留 / Known Gaps

| 项 | 原因 | 建议 |
| :-- | :-- | :-- |
| Docker build/run 未本机验证 | Windows 工作站无 Docker daemon | 用户机器或 CI ubuntu runner 验证；`docker compose config` 已 rc=0 |
| openapi-typescript 未挂 CI | brief 明确 v1.0.x backlog | v1.0.x 加 generate-on-build hook + 把 `.d.ts` 加进 gitignore |
| WS cursor 需 α backend `message_id` 字段才生效 | brief 说由 α 同步 | α 加 `message_id` 后客户端零修改即激活 replay |
| Reclassification undo endpoint 待 α 实现 | brief 说由 α 加 | 等 α push 后 UI 直接生效；当前 404 已 graceful handle |
| `run_all_acceptance.py` 没在本 round 重跑 | α 也在改 backup_restore，避 race | α 完成后 `scripts/run_all_acceptance.py` 应再跑一次确认 10 / 10 |

---

**报告大小**：~10.5 KB / 224 行（≤ 12 KB / 230 行 OK）。
**作者**：Sibling Z（fix-round-3 deploy / UI worker）。
**HEAD**：`3bb2d45e`（自审通过点）。
