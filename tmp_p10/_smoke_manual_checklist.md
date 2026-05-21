# OpenAkita P-RC-9 关闭后 / v2.0.0 打标签前 — 手动 smoke 验收 checklist（简体中文）

> 面向工程维护者，在浏览器 + PowerShell shell 中独立于 AI 驱动的 smoke 跑一遍。
> 预计总耗时：**30 ~ 45 分钟**。每条按 **操作 → 预期 → 失败时怎么办** 描述。
> 重复的服务启停 / 冷启动脚本请直接参考 `tmp_p10/_smoke_startup.md` §2-§3；本文件**只**描述"做什么 / 看什么"。

**当前 HEAD**：`432a4ed6` `fix(frontend): stable bundle version across backend restarts in dev mode [smoke-banner]`
**当前分支**：`revamp/v3-orgs`
**最近修复链**（自旧到新）：`b363bfa8` (F-1) → `e4dba69c` (F-0/F-6) → `6f7e281e` (F-5) → `4fc5c4e6` (F-7) → `432a4ed6` (smoke-banner)
**当前服务**：后端 <http://127.0.0.1:18900> (PID 26600 cold-recovery 后) / 前端 <http://127.0.0.1:5173/web/> (Vite PID 38768)

> 横幅修复 (`432a4ed6`) 后**必须**重启一次 Vite dev server 才能让 dev-sentinel 短路生效（详见第 0.5 节 N1）。

---

## 第 0 节：smoke-fix-1 三大修复回归（必查，~6 min）

### S1. F-5 `PATCH /api/v2/orgs/{id}` 三联组（~3 min）

**操作**：在 PowerShell 中：
1. `$o = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18900/api/v2/orgs -ContentType "application/json" -Body '{"name":"patch-trio-1"}'; $id = $o.id`
2. (b1 正向) `Invoke-WebRequest -Method Patch -Uri "http://127.0.0.1:18900/api/v2/orgs/$id" -ContentType "application/json" -Body '{"name":"renamed"}' -UseBasicParsing`
3. (b2 未知 id) 对 `http://127.0.0.1:18900/api/v2/orgs/org_does_not_exist` 发同样 PATCH，try/catch
4. (b3 空 body) 对 `$id` 发 PATCH，body 为 `{}`

**预期**：
- (b1) `StatusCode = 200`，返回对象 `name = "renamed"`
- (b2) status code = **404**（**不是** 308 或 405）
- (b3) `StatusCode = 200`（空 patch 幂等）

**失败时**：
- (b1) 返回 308 → F-5 修复未生效；`git log --oneline | Select-String "smoke-F5"` 应有 `6f7e281e`；若有就重启后端
- (b2) 返回 308 → mint runtime 没注册 PATCH，落到了 308 shim；查 `src/openakita/api/routes/orgs_v2_runtime_orgs.py` 是否有 `@router.patch("/{org_id}", ...)`
- 抓日志：`tmp_p10/_smoke_backend_v2.log`（或最近 cold-recovery 后的 `_smoke_backend_v3.log` / `_smoke_backend_v4.log`）

### S2. F-0 / F-6 prompt-core 循环导入恢复（~1 min）

**操作**：在仓库根目录跑两条 import：
- `.\.venv\Scripts\python.exe -c "from openakita.prompt.compiler import check_compiled_outdated; print('F-0 OK')"`
- `.\.venv\Scripts\python.exe -c "from openakita.core import Brain; print('F-6 OK', Brain)"`

**预期**：两行都打印 `F-0 OK` / `F-6 OK <class 'openakita.core._brain_legacy.Brain'>`，**无任何 ImportError**。

**失败时**：报 `cannot import name ... (most likely due to a circular import)` → `e4dba69c` 未生效；`git show e4dba69c --stat` 确认补丁仍在 HEAD 链。

### S3. F-7 `core.ReasoningEngine` lazy export（~1 min）

**操作**：
- `.\.venv\Scripts\python.exe -c "from openakita.core import ReasoningEngine; print(ReasoningEngine)"`
- `.\.venv\Scripts\python.exe -m pytest tests/unit/test_core_import_surface.py -q --tb=no`

**预期**：第一条打印 `<class 'openakita.core._reasoning_engine_legacy.ReasoningEngine'>`；第二条 `3 passed`。

**失败时**：`AttributeError: module 'openakita.core' has no attribute 'ReasoningEngine'` → `4fc5c4e6` 三行 lazy import 增补未生效；`Get-Content src/openakita/core/__init__.py | Select-String "_LAZY_IMPORTS|ReasoningEngine"` 应能匹配。

---

## 第 0.5 节：smoke-banner（横幅修复回归，~4 min）

### N1. 重启 Vite dev server（~1 min）

**操作**：先 `Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` 杀旧进程；再按 `_smoke_startup.md` §2.3 用 `VITE_BUILD_TARGET=web` 重启。日志在 `tmp_p10/_smoke_frontend_v3.log`。

**预期**：~6 秒内日志末尾出现 `ready in NNNN ms` 与 `Local: http://127.0.0.1:5173/web/`。

**失败时**：`EADDRINUSE` → Stop-Process 没杀到；列出 `Get-NetTCPConnection -LocalPort 5173 | Format-List` 再补一刀。

### N2. 浏览器硬刷后横幅不再出现（~2 min）

**操作**：
1. 浏览器打开 <http://127.0.0.1:5173/web/>，F12 打开 DevTools → Console
2. Ctrl+Shift+R 硬刷
3. 等 **30 秒**

**预期**：
- Console 出现一行 `[StaleBundleBanner] dev-sentinel bundle id detected ( dev-xxxxx ) -- skipping stale-bundle poll.`
- 页面顶部**没有**橙色 `新版本可用，请刷新页面 [立即刷新]` 横幅
- Network 过滤 `build-info` → **列表为空**（dev-sentinel 命中后压根没注册 setInterval）

**失败时**：
- Console 无 info 行 → 浏览器吃了 service-worker 缓存；DevTools → Application → Service Workers → Unregister；Application → Storage → Clear site data；硬刷
- 横幅仍弹 → 查 `apps/setup-center/src/components/StaleBundleBanner.tsx` line ~62 是否含 `if (!myId || myId.startsWith("dev-"))`；若无，`git log -- apps/setup-center/src/components/StaleBundleBanner.tsx` 确认 `432a4ed6` 还在
- 出现 `/api/build-info` 请求 → 旧 tab 还开着，关掉所有非新硬刷的 tab

### N3. 后端再重启一次，横幅仍不应弹（~1 min）

**操作**：用 `_smoke_startup.md` §2 的命令重启后端 → 等 `/api/health` 返回 200 → 回浏览器 Ctrl+Shift+R → 等 30 秒。

**预期**：横幅**不出现**（这正是用户原始 bug 复发条件）。

**失败时**：横幅出现 → N2 修复未真正应用到当前 Vite bundle；`Get-Content apps\setup-center\src\components\StaleBundleBanner.tsx | Select-String "dev-sentinel"` 应能匹配。

---

## A 节：后端基础存活（~3 min，4 项）

### A1. `/api/health` 200 + agent_initialized（~30 s）

**操作**：`Invoke-RestMethod http://127.0.0.1:18900/api/health | ConvertTo-Json -Depth 4`
**预期**：JSON 含 `status: "ok"`、`agent_initialized: true`、`readiness.http_ready: true`、`version: "1.27.9"`。
**失败时**：500 / 连接拒绝 → 后端没起；按 `_smoke_startup.md` §2.2 重启。

### A2. `/openapi.json` 已知失败 F-2（~15 s）

**操作**：`try { Invoke-WebRequest http://127.0.0.1:18900/openapi.json -UseBasicParsing } catch { $_.Exception.Response.StatusCode.Value__ }`
**预期**：返回 **500**（已知 F-2，15+ 插件 `-> FileResponse` 注解触发 Pydantic 2.12 ForwardRef 解析失败；**不修**）。
**失败时**：返回 200 → 插件兼容修复已落地（好事）；登记到 backlog。

### A3. `/docs` Swagger UI 同 A2（~15 s）

**操作**：浏览器打开 <http://127.0.0.1:18900/docs>。
**预期**：500 错误页（依赖 `/openapi.json`，根因同 A2）。

### A4. 后端日志关键启动行（~30 s）

**操作**：`Get-Content tmp_p10\_smoke_backend_v2.log | Select-String "StreamRegistry|SessionManager started"`
**预期**：至少看到 `[Startup] StreamRegistry cleanup task started` 和 `SessionManager started`。
**失败时**：缺其一 → 启动半途夭折；从日志开头找抛异常的位置。

---

## B 节：v2 orgs CRUD（mint runtime 路径，~5 min，6 项）

> 本节假设 S1 已通过；所有命令针对 mint runtime（POST → GET/PUT/PATCH/DELETE）。

### B1. POST 新 org（~30 s）

**操作**：POST `http://127.0.0.1:18900/api/v2/orgs`，body `{"name":"manual-smoke-B1","description":"smoke-B1 desc"}`；把 response 中的 `id` 存为 `$global:smokeId`。
**预期**：`status = 201`，`id` 形态 `org_...`。
**失败时**：500 → 后端日志看 `OrgManager.create` 栈帧；常见 SQLite 锁。

### B2. GET 单 org（~10 s）

**操作**：`Invoke-RestMethod "http://127.0.0.1:18900/api/v2/orgs/$global:smokeId"`
**预期**：返回对象 `name = "manual-smoke-B1"`。
**失败时**：404 → POST 没真落库；检查 SQLite 路径。

### B3. GET 列表包含新 id（~10 s）

**操作**：`(Invoke-RestMethod http://127.0.0.1:18900/api/v2/orgs).id -contains $global:smokeId`
**预期**：`True`。

### B4. PUT 改名（~15 s）

**操作**：PUT `/api/v2/orgs/$global:smokeId`，body `{"name":"manual-smoke-B4-renamed","description":"x"}`。
**预期**：StatusCode = 200，GET 后 `name = "manual-smoke-B4-renamed"`。

### B5. PATCH 改名（F-5 修复后应 200，~15 s）

**操作**：PATCH `/api/v2/orgs/$global:smokeId`，body `{"name":"manual-smoke-B5-patched"}`。
**预期**：**StatusCode = 200**（不再是 308 → 404），GET 后 `name = "manual-smoke-B5-patched"`。
**失败时**：见第 0 节 S1 失败时排查。

### B6. DELETE 幂等（~20 s）

**操作**：DELETE 两次同一 id。
**预期**：第一次 **200 或 204**；第二次 **404**（删除后幂等错误语义）。

---

## C 节：v2 templates（~3 min，3 项）

### C1. 模板列表完整（~30 s）

**操作**：`$t = (Invoke-RestMethod http://127.0.0.1:18900/api/v2/orgs/templates).id`；检查 `$t -contains 'aigc-video-studio'`、`'software-team'`、`'startup-company'`、`'content-ops'`。
**预期**：4 条全 `True`。
**失败时**：少哪个 → `data/templates/` 是否被改；登记 backlog。

### C2. F-4 nit：仍有非 ASCII id（~15 s）

**操作**：`$t | Where-Object { $_ -cmatch '[^\x00-\x7F]' }`
**预期**：至少打印一个非 ASCII id（当前 `运营团队`）。**已知 F-4 LOW nit**，不阻塞 v2.0.0。

### C3. instantiate aigc-video-studio（~1 min）

**操作**：POST `/api/v2/orgs/templates/aigc-video-studio/instantiate`，body `{"name":"aigc-smoke-C3"}`，检查响应 `nodes.Count`。
**预期**：StatusCode = 200；`nodes.Count >= 5`（模板当前固定 7 节点）。
**失败时**：500 → 后端日志看 `TemplateRegistry.instantiate`；常见模板 JSON 损坏。

---

## D 节：308 shim + Group A 兼容（~2 min，2 项）

### D1. mint runtime GET 不触发 308（~30 s）

**操作**：用 `[System.Net.WebRequest]` 关闭 `AllowAutoRedirect`，GET `/api/v2/orgs/<某新建 id>`。
**预期**：`OK`（即 200）；**不是** `PermanentRedirect (308)`。
**失败时**：返回 308 → mint runtime GET 路由被卸；查 `orgs_v2_runtime_orgs.py` 是否有 `@router.get("/{org_id}", ...)`。

### D2. orgs-spec/templates 仍可工作（~30 s）

**操作**：`Invoke-RestMethod http://127.0.0.1:18900/api/v2/orgs-spec/templates`
**预期**：返回模板 id 列表（与 C1 同源；spec 路由还活着）。
**失败时**：500 / 404 → Group A 路由被误移除；不阻塞 v2.0.0（FE 已 100% 走 v2），但需登记 backlog。

---

## E 节：前端 dev surface（~5 min，4 项）

### E1. 主页加载（~30 s）

**操作**：浏览器 <http://127.0.0.1:5173/web/>。
**预期**：OpenAkita 设置中心首页正常渲染；无白屏；tab 标题正常。
**失败时**：白屏 → Console 若有 `Cannot read properties of null (reading 'useContext')` 即 react-i18next 双实例问题；查 `vite.config.ts` 的 `dedupe`。

### E2. Vite 代理把 /api 转给后端（~30 s）

**操作**：DevTools → Network 过滤 `api/`，触发任一 API 调用（例如点左侧导航"组织"）。
**预期**：看到 `http://127.0.0.1:5173/api/...` 请求，status 200/201/204；response header `server` 为 `uvicorn`（或类似）。
**失败时**：504 / 502 → 代理目标坏；查 `apps/setup-center/vite.config.ts` 的 `server.proxy['/api'].target = 'http://127.0.0.1:18900'`。

### E3. Org 编辑器视图（~2 min）

**操作**：左侧导航 → "组织" → 选 B1/B3 创建的某个 org → 进编辑器 → 在 ReactFlow 画布空白处右键 → 新建节点。
**预期**：节点出现在画布；右侧 detail panel 显示节点 id；无 GlobalErrorBoundary 兜底。
**失败时**：白屏 / "出错了" → Console 看堆栈；常见 chunk 404，硬刷一次。

### E4. 模板抽屉（~1 min）

**操作**：编辑器顶栏 "新建组织 / 模板" → 展开抽屉 → 选一个英文 id 模板 → 点 "立即实例化"。
**预期**：列表 ≥4 项；每条有 `display_name`（中文）+ `id`（多为英文连字符）；实例化成功提示。

---

## F 节：前端源代码 hygiene（sentinel #8 抽查，~2 min，3 项）

### F1. 4 个核心组件不再走 v1 `/api/orgs/` 路径（~1 min）

**操作**：对 `OrgEditorView.tsx` / `OrgProjectBoard.tsx` / `OrgChatPanel.tsx` / `TemplatePickerDrawer.tsx` 4 个文件分别 `Select-String -Pattern "['""]\/api\/orgs\/(?!v2\/)"`。
**预期**：每个文件命中 **0**。
**失败时**：>0 → 有遗漏的 v1 调用；记录文件 + 行号；阻塞 v2.0.0。

### F2. FE/BE version 对齐（~30 s）

**操作**：对比 `(Get-Content apps/setup-center/package.json | ConvertFrom-Json).version` 与 `(Invoke-RestMethod http://127.0.0.1:18900/api/health).version`。
**预期**：两侧相等（当前 `1.27.9`；打 v2.0.0 前需先升级两侧）。
**失败时**：不一致 → 哪边没升；`npm version` 或编辑 `pyproject.toml` 对齐。

### F3. Vite 代理 target 正确（~15 s）

**操作**：`Get-Content apps/setup-center/vite.config.ts | Select-String "127.0.0.1:18900"`
**预期**：至少 1 行命中。
**失败时**：无命中 → 代理 target 改了；E2 也会跟着挂。

---

## G 节：哨兵 + 测试套件（~6 min，5 项）

> **本节定义 v2.0.0 标签的硬门槛**。任一 FAIL → 不打 v2.0.0。

### G1. orgs parity / 哨兵全绿（~2 min）

**操作**：`.\.venv\Scripts\python.exe -m pytest tests/parity/orgs/ -q --tb=no`
**预期**：`68 passed`（或更多）。
**失败时**：定位哪个 sentinel 红 → 对应文件 README 给出修复指引。

### G2. F-1 DI wiring 回归（~1 min）

**操作**：`.\.venv\Scripts\python.exe -m pytest tests/api/test_server_app_wiring.py -q --tb=no`
**预期**：`2 passed`。

### G3. stall_detector 套件（ADR-0014，Acceptance #1）（~1 min）

**操作**：`.\.venv\Scripts\python.exe -m pytest tests/runtime/test_stall_detector.py -q --tb=no`
**预期**：全 passed。

### G4. cancel_wall_clock_budget（ADR-0013，Acceptance #2）（~1 min）

**操作**：`.\.venv\Scripts\python.exe -m pytest tests/runtime/test_cancel_wall_clock_budget.py -q --tb=no`
**预期**：全 passed。

### G5. smoke-banner 前端单测（新增，~1 min）

**操作**：`cd apps/setup-center; npx --no-install vitest run src/components/__tests__/StaleBundleBanner.test.tsx; cd ..\..`
**预期**：`Tests 3 passed`（含新增的 dev-sentinel 案例）。
**失败时**：`Tests 2 passed` → `432a4ed6` 未生效或被回滚；`git log --oneline | Select-String "smoke-banner"` 确认。

---

## H 节：冷启动恢复（~3 min，1 项）

### H1. 后端进程级 cold-recovery（~3 min）

**操作**：按 `_smoke_startup.md` §3 的命令模板：杀 18900 进程 → wait 3s → `openakita serve` → 轮询 `/api/health` 至 ready → `Invoke-RestMethod /api/v2/orgs` 看之前 session 留下的 orgs 是否仍在。
**预期**：30s 内 ready；列表里仍能看到 B 节创建（且未删）的 orgs。
**失败时**：超时 → 看新 log 最后一帧；常见 SQLite `.db-shm` / `.db-wal` 残留锁；删除后重启。

---

## I 节：已知不修（read-only 确认，~1 min，2 项）

### I1. F-2 plugin-induced `/openapi.json` 500（同 A2）
**预期**：仍 500，不阻塞 v2.0.0。Backlog：让各插件 `-> FileResponse` 注解改 `model_rebuild` 或字符串 forward-ref。

### I2. F-4 非 ASCII 模板 id `运营团队`（同 C2）
**预期**：仍存在。Backlog：改 ASCII id + display_name 中文。

---

## 第 X 节：v2.0.0 放行 / 不放行 决策表

> **所有 BLOCKER 行 PASS** 才可执行 `git tag v2.0.0`。NIT 行仅登记 backlog，不阻塞。

| 编号 | 项目 | 等级 | 通过条件 | PASS/FAIL |
|---|---|---|---|---|
| S1   | F-5 PATCH 三联组 | BLOCKER | (b1=200, b2=404, b3=200) | □ |
| S2   | F-0/F-6 prompt-core import 恢复 | BLOCKER | 两条 import 均不抛 | □ |
| S3   | F-7 `core.ReasoningEngine` lazy export | BLOCKER | import 通 + 3 passed | □ |
| N2   | banner 在 dev 模式硬刷后不出现 | BLOCKER | Console 有 dev-sentinel info；UI 无横幅 | □ |
| N3   | backend 重启后 banner 仍不弹 | BLOCKER | UI 无横幅 | □ |
| A1   | `/api/health` 200 + agent_initialized | BLOCKER | 见 A1 预期 | □ |
| A4   | backend 日志关键启动行 | NIT     | 两行都有 | □ |
| B1-B4| v2 orgs 基本 CRUD (POST/GET/list/PUT) | BLOCKER | 4 项全过 | □ |
| B5   | PATCH 主路径 200（与 S1.b1 重复） | BLOCKER | 200 + name 变化 | □ |
| B6   | DELETE 幂等 | BLOCKER | 第二次 404 | □ |
| C1   | 4 个核心模板 id 全部存在 | BLOCKER | 4 行 True | □ |
| C3   | aigc-video-studio instantiate 200 + 节点齐 | BLOCKER | 200 + nodes ≥ 5 | □ |
| D1   | mint runtime GET 不再 308 | BLOCKER | 200 | □ |
| D2   | orgs-spec/templates 仍工作 | NIT     | 200 | □ |
| E1-E4| 前端 4 项手感检查 | BLOCKER | 全过 | □ |
| F1   | 4 核心组件无 v1 `/api/orgs/` 残留 | BLOCKER | 4 行均 0 hits | □ |
| F2   | FE/BE version 对齐 | NIT     | 相等 | □ |
| F3   | Vite 代理 target 正确 | BLOCKER | 1+ 命中 | □ |
| G1   | parity/orgs 全绿 | BLOCKER | 68+ passed | □ |
| G2   | F-1 DI 回归 | BLOCKER | 2 passed | □ |
| G3   | stall_detector 全绿 | BLOCKER | all passed | □ |
| G4   | cancel_wall_clock_budget 全绿 | BLOCKER | all passed | □ |
| G5   | smoke-banner 前端单测 | BLOCKER | 3 passed | □ |
| H1   | backend cold-recovery + 数据持久 | BLOCKER | ready + orgs 在 | □ |
| A2/A3/I1 | `/openapi.json` + `/docs` 500 (F-2) | KNOWN-FAIL | 仍 500 (不修) | □ (确认) |
| C2/I2 | 非 ASCII 模板 id (F-4) | KNOWN-NIT | 仍存在 (不修) | □ (确认) |

**判定**：所有 BLOCKER PASS → **可打 `git tag v2.0.0`**；任一 BLOCKER FAIL → 修复后回到对应小节重跑，禁止跳过。

---

## 附：服务进程清理

`Get-NetTCPConnection -LocalPort 18900,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

> 历史英文版本保留在 `tmp_p10/_smoke_manual_checklist_en_backup.md`，供对照查阅。
