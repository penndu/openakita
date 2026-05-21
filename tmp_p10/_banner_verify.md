# Banner Fix Verification Recipe — `smoke-banner`

## Goal

确认修复后，在 **dev 模式** 下用户硬刷浏览器时 `新版本可用，请刷新页面` 横幅**不会**再出现，且**生产构建**的 stale-bundle 检测能力**未被削弱**。

---

## 1. 自动化回归（已通过）

```powershell
# Frontend unit (vitest)
cd D:\OpenAkita\apps\setup-center
npx --no-install vitest run src/components/__tests__/StaleBundleBanner.test.tsx

# 预期: 3 passed (含新增的 "stays hidden in dev mode when bundle id is the dev-<timestamp> sentinel")
```

```powershell
# Backend build-info contract (未修改后端，仅做兜底回归)
cd D:\OpenAkita
.\.venv\Scripts\python.exe -m pytest tests/api/test_build_info.py -q
# 预期: 3 passed
```

实测 2026-05-21 13:52:
- vitest 15 passed (5 file)
- pytest build_info + 2 sentinels = 8 passed in 3.68s

---

## 2. 手工 smoke（用户在浏览器侧自行复核）

> 前置：后端 PID 26600（端口 18900）、前端 Vite PID 38768（端口 5173）均仍然在跑。

### 2.1 重启前端 Vite dev server（让新代码生效）

```powershell
# 终止旧 Vite
Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 重启
cd D:\OpenAkita\apps\setup-center
$env:VITE_BUILD_TARGET = "web"
Start-Process -FilePath npm -ArgumentList "run","dev" -RedirectStandardOutput ..\..\tmp_p10\_smoke_frontend_v2.log -NoNewWindow

# 等 ~6s 直到 "ready in NNNN ms" 出现在日志末尾
Start-Sleep 8
Get-Content ..\..\tmp_p10\_smoke_frontend_v2.log -Tail 5
```

### 2.2 浏览器步骤

1. 打开 <http://127.0.0.1:5173/web/>
2. F12 -> Console；硬刷 (Ctrl+Shift+R)
3. **预期 A**: Console 应看到一行 `[StaleBundleBanner] dev-sentinel bundle id detected ( dev-xxxxx ) -- skipping stale-bundle poll.`
4. **预期 B**: 等 30s（横幅原触发延迟 5s + 一个 poll 间隔）；页面顶部**不应**出现橙色"新版本可用，请刷新页面"横幅
5. **预期 C**: F12 -> Network 过滤 `build-info`；应**没有任何** `GET /api/build-info` 请求（因为 useEffect 在 dev-sentinel 命中后 early return，根本没注册 setInterval）
6. **预期 D**: 让浏览器停留 2 分钟（>1 个 poll 周期）；横幅仍**不出现**

### 2.3 模拟"backend 重启" 场景

```powershell
# 终止后端
Get-NetTCPConnection -LocalPort 18900 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 重启
$env:PYTHONUTF8 = "1"
Start-Process -FilePath .\.venv\Scripts\python.exe -ArgumentList "-m","openakita","serve" -RedirectStandardOutput tmp_p10\_smoke_backend_v3.log -NoNewWindow
Start-Sleep 30
Invoke-WebRequest http://127.0.0.1:18900/api/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

回到浏览器硬刷 -> **预期**: 横幅仍**不出现**（即使后端被换了进程；这正是修复前用户报告的"刷新无效"复发条件，现在它该被消除）。

---

## 3. 生产构建未受削弱的论证（不需要现在跑，仅 CI/release 时验证）

```powershell
# 在 CI 中:
$env:VITE_BUILD_ID = "ci-1234abcd"
$env:VITE_BUILD_TARGET = "web"
cd D:\OpenAkita\apps\setup-center
npm run build
```

- 生成的 `dist-web` 中 `__BUILD_ID__` 被定义为 `"ci-1234abcd"`，**不**以 `dev-` 开头
- StaleBundleBanner 的 dev-sentinel 短路条件 (`myId.startsWith("dev-")`) **不命中** -> 老的轮询逻辑全开
- 当后端 `OPENAKITA_BUILD_ID=ci-9999wxyz`（新一轮部署）时与前端 `ci-1234abcd` 不匹配 -> 横幅按设计触发

---

## 4. 失败排查表

| 现象 | 可能原因 | 抓哪份日志 |
|---|---|---|
| 浏览器仍弹横幅 | 浏览器走了 service worker 缓存的旧 bundle | DevTools -> Application -> Service Workers -> Unregister；Ctrl+Shift+R |
| Console 没有 dev-sentinel info 行 | Vite 没重启，老 bundle 还在 | `Get-NetTCPConnection -LocalPort 5173 | Format-List`；确认 PID 不是 38768 |
| 仍有 `/api/build-info` 请求 | 浏览器开了多个 tab，旧 tab 仍在 poll | 关掉所有非新刷新的 tab |
| vitest 报 "bundleId not provided to BannerProps" | 我们没改默认行为，应该排查 jsdom 是否定义了 `__BUILD_ID__` | 看 `apps/setup-center/vite.config.ts` 里 `define.__BUILD_ID__` 是否仍有 |

---

## 5. 简版"放行/不放行"判断

| 检查 | 通过条件 | 当前状态 |
|---|---|---|
| vitest banner suite 3/3 通过 | `Tests 3 passed` | ✅ PASS (2026-05-21 13:52) |
| pytest build_info 3/3 通过 | `3 passed` | ✅ PASS |
| 浏览器硬刷不再弹横幅 | DevTools Console 出现 dev-sentinel info；横幅不显示 | ⏳ 待用户在浏览器中复核 |
| 后端 `/api/build-info` 跨重启稳定 | 3 次 probe 返回相同 `build_id` | ✅ PASS (`1.27.9` x3) |
| 生产构建检测能力未削弱 | 代码评审：dev-前缀短路 only | ✅ PASS (CI 注入 `VITE_BUILD_ID` 时不命中) |
