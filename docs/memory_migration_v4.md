# 记忆系统 v4 升级与回滚指南

> 适用版本：v1.27.10 → v1.28（含 schema 升级）
>
> 影响面：所有桌面端、CLI、API、IM 用户。第一次启动会触发一次性 schema 迁移和 `memories.json` 归档。

---

## 1. 你为什么会看到这份文档

如果你从 v1.27 之前升级上来，可能遇到过以下三类问题之一：

1. **"Legacy / 旧版记忆"提示反复弹出**，即使你已经"导入"过一次；
2. **越聊越慢**：上下文一长，每轮响应明显比刚启动时拖；
3. **记忆数据在 `memories.json` 和 SQLite 之间打架**：你删过的条目又冒出来，或者你新加的没存住。

v4 这一轮升级把这三件事的根因一次性收拾掉了。

---

## 2. 这次升级做了什么（按用户角度）

### 2.1 banner 不再反复骚扰

| 旧行为 | 新行为 |
|---|---|
| 后台合成记忆会被错误塞回 `legacy_quarantine`，导致"待整理"计数永远清不空 | 后台合成产物落到独立的 `pending_consolidation` 桶，**用户不可见、不触发 banner** |
| 没有"不再提醒"选项，每次启动都要点掉 | UI 提供三个选项：**整理导入** / **稍后提醒**（本会话） / **不再提醒**（永久） |
| 导入成功后如果未来又出现新 legacy，banner 不再亮 | "永久不再提醒"会在你下次主动 claim-legacy 成功后被自动重置 |

后端 API 增加了 `show_banner`、`banner_dismissed`、`api_version` 字段。前端只信 `show_banner`，banner 决策完全收敛到后端。

### 2.2 旧 `memories.json` 自动归档

- v4 首次启动会做一次 backfill：把 `memories.json` 里的数据塞进 SQLite（含 `_LEGACY_JSON_BACKFILL_SENTINEL` 守卫，绝不重复执行）；
- backfill 完成后 `memories.json` 自动改名为 `memories.json.archived.<timestamp>`；
- 此后 `_save_memories()` 是 no-op，SQLite 成为唯一真相源；
- 如果你担心 backfill 出错，**归档文件原样保留**，可以手动改回 `memories.json` 触发回滚（见 §5）。

### 2.3 多用户 / 多 workspace 隔离闭环

- `_GlobalStoreSource` 严格按 `(user_id, workspace_id)` 过滤，禁止跨用户回流；
- placeholder 身份（`anonymous` / `legacy` / `system`）不能从 global store 取记忆；
- 新增 `session_tenants` 表，把 `session_id` 显式映射到 `(user_id, workspace_id)`；
- v3 → v4 升级时会扫描 `conversation_turns` 自动回填该表，老会话不丢归属；
- 新增 API：`POST /api/memories/migrate-workspace`，可以把当前用户在 workspace A 的记忆迁到 workspace B，事务保护 + 审计日志。

### 2.4 性能优化（Phase 5）

| 优化点 | 收益 |
|---|---|
| 默认使用 compact Memory Guide | 每轮 prompt 节省 ~600 token |
| 短 chitchat（"ok"/"嗯"/"继续"/≤4 字符）跳过 Layer 4 多路语义召回 | 短消息响应延迟显著下降；identity slot 不受影响 |
| MEMORY.md 进程级 mtime 缓存 | 同一文件不再每轮重读 + truncate；LLM prompt 缓存命中率更稳定 |

性能开关：

- `OPENAKITA_PROMPT_VERBOSE_MEMORY_GUIDE=1` —— 强制使用完整版 Memory Guide（旧行为，约 815 token）。一般只用于调试 / 评估。

---

## 3. Schema 变更清单（v3 → v4）

`MemoryStorage._SCHEMA_VERSION = 4`。升级时会按下表执行：

| 动作 | 落点 |
|---|---|
| `legacy_quarantine` 中 `source IN ('daily_consolidation', 'experience_synthesis')` 的记忆 → 迁到 `pending_consolidation` | `memories` 表 |
| 真历史 v1/v2 旧数据继续留在 `legacy_quarantine` | `memories` 表 |
| 每条迁移产生一条 `pre_scope → new_scope` 记录 | 新表 `_memory_scope_audit` |
| 从 `conversation_turns` 反推 `session_id → (user_id, workspace_id)`，回填到 `session_tenants` | 新表 `session_tenants` |
| `legacy_json_backfill_done` sentinel | 沿用 `_schema_meta` |
| `legacy_banner_dismissed` sentinel | 沿用 `_schema_meta` |

### 自动备份

升级前会把 `openakita.db` 复制到 `openakita.db.bak.v3_to_v4.<timestamp>`（如果是从 v2 升上来则名字带 `v2_to_v4`）。SQLite 文件级别的回滚直接覆盖回来即可。

---

## 4. API 变更

### 4.1 GET `/api/memories/migration-status`

新增字段：

```json
{
  "api_version": "v4",
  "show_banner": true,
  "banner_dismissed": false,
  "pending_consolidation": 0,
  // ... 原有字段保持兼容
  "has_recoverable_legacy": true,
  "legacy_pending": 3,
  "legacy_reviewed": 0,
  "legacy_quarantine": 3,
  "current_visible": 12
}
```

老前端（不感知 `show_banner`）会自动回退到看 `has_recoverable_legacy`，行为与 v3 一致。

### 4.2 POST `/api/memories/legacy/dismiss`

新端点。把 `_schema_meta.legacy_banner_dismissed` 置为 `"1"`，幂等。下次 `migration-status` 会返回 `show_banner=false`，直到：

- 用户成功调用 `POST /api/memories/claim-legacy`（自动清除 sentinel），或
- 你手动把 `_schema_meta.legacy_banner_dismissed` 删掉。

### 4.3 POST `/api/memories/migrate-workspace`

请求体：

```json
{
  "from_workspace_id": "default",
  "to_workspace_id": "proj-7a1c98ab2e44",
  "scope": "user"
}
```

行为：

- 只动当前请求会话身份所属 `user_id` 的记忆，绝不跨用户搬运；
- 默认 `scope='user'`，不动 `legacy_quarantine` / `pending_consolidation` / `session` 桶；
- 事务保护，失败 ROLLBACK；
- 每条迁徙记录写入 `_memory_scope_audit` 表，可追溯。

---

## 5. 回滚预案

### 5.1 仅回滚 banner / 文案变化（最轻）

- 把 `apps/setup-center/dist-web` 替换为旧版打包；
- 后端兼容老前端，老前端只看 `has_recoverable_legacy`，行为与 v3 一致。

### 5.2 回滚 prompt 性能优化

- 设置环境变量 `OPENAKITA_PROMPT_VERBOSE_MEMORY_GUIDE=1`，恢复完整版 Memory Guide；
- 短消息跳过召回的逻辑没有 env 开关，**如果必须关掉**，请反向 cherry-pick `perf(prompt): Phase 5` 那个 commit。

### 5.3 回滚 schema（最重）

适用场景：怀疑 v4 迁移把数据搞坏。

```bash
# 1. 停掉所有 openakita 进程（后端 / 桌面 / IM）
# 2. 找到 v3 → v4 升级时自动备份的 db
ls ~/.openakita/openakita.db.bak.v3_to_v4.*

# 3. 把当前 db 重命名留底，备份覆盖回去
mv ~/.openakita/openakita.db ~/.openakita/openakita.db.v4-broken
cp ~/.openakita/openakita.db.bak.v3_to_v4.<timestamp> ~/.openakita/openakita.db

# 4. 启动旧版（v1.27.x）二进制 / wheel
```

注意：

- 如果你已经在 v4 下产生了新对话，**这些对话会丢失**（v3 不识别 v4 新增字段）。回滚前请先 `openakita memory export` 或手动复制 `memories.json.archived.*` 留底。
- v4 把 `memories.json` 改名了。回滚到 v3 前请把 `memories.json.archived.<timestamp>` 改回 `memories.json`，否则 v3 会以为是首次启动。

### 5.4 我只想恢复一次"导入旧记忆"的提示

```bash
# 在 OPENAKITA_DB（默认 ~/.openakita/openakita.db）执行：
sqlite3 ~/.openakita/openakita.db \
  "UPDATE _schema_meta SET value='0' WHERE key='legacy_banner_dismissed';"
```

下次 `migration-status` 会再次返回 `show_banner=true`（前提是确实还有 `legacy_pending > 0`）。

---

## 6. 升级前自查清单

- [ ] 备份 `~/.openakita/openakita.db`（最稳妥）；
- [ ] 留意启动日志里这两行：
  - `[MemoryStorage] v3→v4 split: moved %d rows ...`
  - `[MemoryStorage] v3→v4 backfill: registered %d session_tenants entries`
- [ ] 如果你跑过自定义脚本直接读 `memories.json`，请改成读 SQLite 或 API；
- [ ] 如果你的 IM 部署有多个 workspace 共用一个 db，启动后检查 `GET /api/memories/migration-status` 的 `semantic.by_owner` 字段，确认每个 user/workspace 行数正常；
- [ ] 大规模部署建议先在测试环境跑一遍，再灰度。

---

## 7. 已知边界 / 后续计划

- `multi_agent_enabled` 已经默认为 `True`，**没有**开关可以关掉（参考 `AGENTS.md`）；
- Phase 2b 的剩余项（`episode` / `scratchpad` / `conversation_turns` 按 user/workspace 过滤、`memory_mode → memory_isolation` 字段重命名）会在下一个 minor 版本继续推进；
- Phase 3（`process_unextracted_turns` / `synthesize_experiences` 完全按 tenant 分组、彻底废弃 `_memories` 原始读取）也在路上。

如果你在升级过程中遇到异常，请走 `openakita bugreport` 收集崩溃信息后提交 issue。
