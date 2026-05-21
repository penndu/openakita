# Banner Root Cause Diagnosis -- "新版本可用，请刷新页面"

**Date**: 2026-05-21 (UTC+8 ~13:00)
**Branch**: revamp/v3-orgs
**HEAD**: 4fc5c4e6 (smoke-fix-1c)
**Reporter**: 用户报告刷新后横幅仍然出现

## 1. Banner component

- **File**: `apps/setup-center/src/components/StaleBundleBanner.tsx` (138 lines)
- **Mount site**: `apps/setup-center/src/main.tsx:430` (`<StaleBundleBanner />` 紧贴 React root，先于 `GlobalErrorBoundary`)
- **Trigger 文本**: line 117 (`<span>新版本可用，请刷新页面</span>`)
- **轮询逻辑**: 组件挂载后等 `initialDelayMs=5000ms`，再每 `pollMs=60000ms` 调用 `GET ${apiBase}/api/build-info`；返回的 `build_id` 与编译时常量 `__BUILD_ID__` 比较，不一致即把 `stickyRef.current = true` 并永久显示横幅（即使后续 poll 又一致也不会撤销，这是 P-RC-2 设计如此）。

## 2. 编译期常量来源 (frontend)

- **File**: `apps/setup-center/vite.config.ts:17`
- **代码**: `const buildId = process.env.VITE_BUILD_ID || ` + 反引号 `dev-${Date.now().toString(36)}` + 反引号
- **行为**:
  - 生产构建 (CI): `VITE_BUILD_ID` 由 CI 注入为 short SHA / timestamp -> 稳定可比对
  - 本地 `npm run dev` (今天的工况): `VITE_BUILD_ID` 未设置 -> 退化为 `dev-mfh3xyz` 形式，**Vite dev server 启动那一刻的 `Date.now()` 取 36 进制**，整个 Vite 进程生命周期内不变

## 3. 后端值来源

- **File**: `src/openakita/api/routes/build_info.py`
- **解析顺序** (`_resolve_build_id`):
  1. `OPENAKITA_BUILD_ID` 环境变量（未设置）
  2. `importlib.metadata.version("openakita")` -> 实测 `1.27.9`
  3. 兜底 `"dev"`

## 4. 实测证据

```text
PS> $env:OPENAKITA_BUILD_ID
(empty)

PS> Invoke-WebRequest http://127.0.0.1:18900/api/build-info
STATUS=200
{"build_id":"1.27.9"}

PS> python -c "from importlib.metadata import version; print(version('openakita'))"
1.27.9
```

前端编译期常量 `__BUILD_ID__` 形如 `"dev-mfh3xyz"`（按 Vite 启动时间取 36 进制；不同 Vite 重启会变，但同一次 Vite 进程内不变）。

## 5. 为什么"刷新也不消失"

- 浏览器硬刷只是重新加载 HTML/JS，但 Vite dev server 仍是同一进程，`__BUILD_ID__` 仍为同一份 `dev-<timestamp>`
- 后端 `_resolve_build_id` 在 dev 模式下永远返回 `1.27.9`（包元数据）
- 两个命名空间完全无交集；只要前端不重启 Vite **或** 后端不被改成返回 `dev-<timestamp>`，比较永远失败
- 一旦失败，`stickyRef.current = true` 永久粘住 (`if (cancelled || stickyRef.current) return;`)，下次 poll 直接 short-circuit -> 横幅锁死

## 6. 命中假设

**假设 A + B + C 的综合**：
- **A 部分中**: 后端的 `1.27.9` 跨进程稳定（来源于 `pyproject.toml` 包版本），但和前端是两个 namespace
- **B 命中**: 前端 dev 模式用 `dev-<timestamp>` sentinel；后端用包版本号；二者天然永远不等
- **C 部分中**: 后端没有依赖 `dist-web/.vite/manifest.json`，而是降级到包元数据 -> 在 dev 模式产生 dev<->prod 数值的语义错位

实际 **B 是直接成因**，A 只是雪上加霜（即使前端 dev id 跨重启稳定，也仍然永远不等于后端的 `1.27.9`）。

## 7. 拟应用 fix（≤ 100 LOC，3 文件以内）

**核心思路**: 在前端 banner 里识别 dev-sentinel 模式（`__BUILD_ID__` 以 `"dev-"` 前缀开头）并跳过比较与轮询。`vite.config.ts` L17 已经定义了这个前缀只在 `VITE_BUILD_ID` **未设置** 时出现；CI/生产构建必须显式注入 `VITE_BUILD_ID`，因此生产侧的过期 bundle 检测完全不受影响。

变更点（共 ≤ 50 LOC）:

1. `apps/setup-center/src/components/StaleBundleBanner.tsx`
   - 在 `useEffect` 顶部加 dev-sentinel 短路: `if (!myId || myId.startsWith("dev-")) return;`
   - 同步更新文件头 JSDoc 说明 dev-sentinel 跳过规则
   - 新增 `console.info` 一行（仅 dev-sentinel 命中时输出一次），方便排障

2. `apps/setup-center/src/components/__tests__/StaleBundleBanner.test.tsx`
   - 新增 1 个回归 case: `bundleId="dev-abc123"` 时即使 `fetchImpl` 返回不同 `build_id` 也不应有任何 fetch 调用，更不应渲染 banner

3. (不动) 后端 `src/openakita/api/routes/build_info.py` 与 `tests/api/test_build_info.py` —— 后端逻辑本身没问题，问题在前端无法识别 dev 模式

**符合硬规则**:
- 不动 sentinel #1-#9（仅 #7 在 smoke-fix-1b 中合法更新过，本次也不动）
- 不动 308 shim / runtime/orgs/ / ADR / docs/revamp/
- 不新增 feature flag（dev-sentinel 是已有约定的副作用，非新开关）
- LOC < 100，files ≤ 3

**生产保护**:
- 当 CI 注入 `VITE_BUILD_ID=ci-1234abcd` 时，`__BUILD_ID__` = `"ci-1234abcd"`（无 `dev-` 前缀） -> 老逻辑全开
- 后端在生产重新部署后 `build_id` 变化 -> 仍能正确触发横幅
