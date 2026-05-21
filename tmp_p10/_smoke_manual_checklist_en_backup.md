# tmp_p10/_smoke_manual_checklist.md

# OpenAkita P-RC-9 post-closure manual smoke checklist

For the maintainer to drive in a browser + a PowerShell / curl shell, independent of the AI-driven smoke run. ~25 minutes end-to-end. Tick each row.

**Backend**: <http://127.0.0.1:18900>
**Frontend**: <http://127.0.0.1:5173/web/>

> If either server is not listening (e.g. machine rebooted), the AI session's `_smoke_startup.md` has the exact launch commands.

## A. Backend basic liveness (4 items)

- [ ] **A1.** `GET http://127.0.0.1:18900/api/health` returns `{ "status": "ok", "agent_initialized": true, "readiness": { "http_ready": true, ... } }`. (Confirms F-1 fix held.)
- [ ] **A2.** `http://127.0.0.1:18900/openapi.json` returns **500** (KNOWN FAIL F-2, plugin-induced; not a P-RC-9 issue). The 500 traceback in the backend log mentions `TypeAdapter[ForwardRef('FileResponse')]`. Once the plugin compat fix lands, this should become a 200 with ~80-100 path entries.
- [ ] **A3.** `http://127.0.0.1:18900/docs` returns **500** for the same reason as A2.
- [ ] **A4.** Backend log (`tmp_p10/_smoke_backend_v2.log`) contains `[Startup] StreamRegistry cleanup task started` and `SessionManager started`. (Confirms full boot path.)

## B. v2 orgs CRUD (live, expected to PASS on the mint runtime) (6 items)

- [ ] **B1.** `POST http://127.0.0.1:18900/api/v2/orgs` with JSON `{"name":"manual-smoke-1"}` -> **201**. Capture the `id` field (looks like `org_xxxxxxxxxxxx`).
- [ ] **B2.** `GET http://127.0.0.1:18900/api/v2/orgs/<id>` -> **200** with same name.
- [ ] **B3.** `GET http://127.0.0.1:18900/api/v2/orgs` -> **200** with an array including the just-created id.
- [ ] **B4.** `PUT http://127.0.0.1:18900/api/v2/orgs/<id>` with `{"name":"renamed"}` -> **200** (use **PUT, NOT PATCH**; see F-5).
- [ ] **B5.** `PATCH http://127.0.0.1:18900/api/v2/orgs/<id>` with `{"name":"x"}` -> **expected 404 today** -- this is **F-5 (HIGH)**, the dual-store PATCH falls through to the wrong store. If it returns 200, the F-5 fix has landed.
- [ ] **B6.** `DELETE http://127.0.0.1:18900/api/v2/orgs/<id>` -> **204** (or 200). A second DELETE -> **404** (idempotent semantic).

## C. v2 templates surface (3 items)

- [ ] **C1.** `GET http://127.0.0.1:18900/api/v2/orgs/templates` -> 200 with an array; verify it contains `aigc-video-studio`, `software-team`, `startup-company`, `content-ops`.
- [ ] **C2.** Same list contains at least one **non-ASCII id** (currently the Chinese label `运营团队` is registered as an id). **This is F-4 (LOW nit)** -- recommend ASCII-only ids with Chinese in `display_name`.
- [ ] **C3.** `POST http://127.0.0.1:18900/api/v2/orgs/templates/aigc-video-studio/instantiate` with JSON `{"name":"aigc-smoke"}` -> 200 with a fresh org id and ~7 nodes in the `nodes` array.

## D. 308 shim + Group A spec (2 items)

- [ ] **D1.** `curl -i http://127.0.0.1:18900/api/v2/orgs/<some-id>` -- look at the response. If served by mint runtime: 200. If served by shim: 308 with `Location: /api/v2/orgs-spec/<id>`. (Per F-5: most verbs are served by mint runtime; PATCH is the leaky one.)
- [ ] **D2.** `curl -i http://127.0.0.1:18900/api/v2/orgs-spec/templates` -> 200 with the Group A list (same canonical content; spec route serves it).

## E. Frontend dev surface (4 items)

- [ ] **E1.** Open `http://127.0.0.1:5173/web/` in a browser. The OpenAkita setup-center loads (HTML + JS bundles).
- [ ] **E2.** Browser network panel: API requests go through the Vite proxy (look for `http://127.0.0.1:5173/api/*` in the Network tab; the request is then proxied to `:18900`).
- [ ] **E3.** Open the Org editor view. The page renders (no white-screen on React-i18next dispatch -- this matters because `vite.config.ts` dedupes React, react-dom, react-i18next).
- [ ] **E4.** Template picker drawer lists templates with hyphenated ids (UI may render the Chinese display name; check the debugger for `id` field on each item).

## F. Frontend source hygiene (sentinel #8 surface) (3 items)

- [ ] **F1.** `grep -nE "['\"]/api/orgs/(?!v2/)" apps/setup-center/src` returns 0 hits in OrgEditorView, OrgProjectBoard, OrgChatPanel, TemplatePickerDrawer. (Sentinel #8 holds the line; spot-check 4 files.)
- [ ] **F2.** `apps/setup-center/package.json` version field matches the backend `/api/health.version` (both `1.27.12`).
- [ ] **F3.** `apps/setup-center/vite.config.ts` `server.proxy['/api'].target` points to `http://127.0.0.1:18900`.

## G. Sentinels + tests (5 items)

- [ ] **G1.** `.venv\Scripts\python.exe -m pytest tests/parity/orgs/ -q --tb=no` -> 68 passed.
- [ ] **G2.** `.venv\Scripts\python.exe -m pytest tests/api/test_server_app_wiring.py -q --tb=no` -> 2 passed (F-1 regression guard).
- [ ] **G3.** `.venv\Scripts\python.exe -m pytest tests/runtime/test_stall_detector.py -q --tb=no` -> all green (Acceptance criterion #1).
- [ ] **G4.** `.venv\Scripts\python.exe -m pytest tests/runtime/test_cancel_wall_clock_budget.py -q --tb=no` -> all green (Acceptance criterion #2, ADR-0013).
- [ ] **G5.** `git log -1 --format='%H %s'` -> `<HEAD-hash> fix(api): wire v2 OrgRuntime/OrgCommandService keyword-only DI in create_app [smoke-RT001]` (commit `b363bfa8`).

## H. Cold-recovery (1 item)

- [ ] **H1.** Stop the backend (`Get-NetTCPConnection -LocalPort 18900 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`), wait 2s, restart (`openakita serve`), wait for `/api/health.readiness.http_ready=true`, then `GET /api/v2/orgs` should still include the orgs from earlier this session. (RT017 in the AI smoke confirmed this; this checklist item gives the maintainer a chance to re-verify on their own hardware.)

## I. Known-but-not-fixing items (read-only confirmation) (2 items)

- [ ] **I1.** Confirm F-0 is reproducible: from a fresh shell, `.venv\Scripts\python.exe -c "from openakita.prompt.compiler import check_compiled_outdated; print('ok')"` -> ImportError (circular). Identity is already compiled (`identity/runtime/.compiled_at` exists), so this only matters if you need to recompile from a clean Python session.
- [ ] **I2.** Confirm F-5 PATCH gap is reproducible: create-then-PATCH on `/api/v2/orgs/{id}` -> 404. (Mitigation: use PUT for now.)

## How to stop the running smoke servers

```powershell
Get-NetTCPConnection -LocalPort 18900,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```
