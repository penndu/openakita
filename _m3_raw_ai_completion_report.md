# M3 Sibling B — Advanced AI (🔴 raw) Completion Report

**Branch:** `revamp/v3-orgs`  
**Worker:** M3 Sibling B (Advanced AI scenarios + REST endpoints)  
**Scope:** S6 / S7 / S11 high-sensitivity scenarios, SQL guard, prompt-injection guard, raw REST surface, event-bus subscriber, acceptance script.

---

## 1. Commit chain (5 commits)

| # | SHA | Title |
|---|---|---|
| 1 | `ffd30bf8` | `feat(finance-auto): add SQL guard helper and 3 raw AI prompt templates` |
| 2 | `e6e0671e` | `feat(finance-auto): add 3 M3 raw AI scenarios and registry entries` |
| 3 | `b569d2ee` | `feat(finance-auto): wire M3 raw AI routes and event subscriber` |
| 4 | `0d17f7c8` | `test(finance-auto): add M3 raw AI 12-check acceptance script` |
| 5 | (this report) | `docs(finance-auto): add M3 raw AI completion report` |

Every commit body explains WHY / WHAT / VERIFICATION in English, ≥ 3 lines.

---

## 2. Files added / edited (territory check)

**Added (10):**

```
plugins/finance-auto/finance_auto_backend/ai/sql_guard.py
plugins/finance-auto/finance_auto_backend/ai/raw_routes.py
plugins/finance-auto/finance_auto_backend/ai/scenarios/raw_audit_opinion.py
plugins/finance-auto/finance_auto_backend/ai/scenarios/raw_nl_query.py
plugins/finance-auto/finance_auto_backend/ai/scenarios/raw_notes_draft.py
plugins/finance-auto/templates/ai_prompts/raw_audit_opinion.md.j2
plugins/finance-auto/templates/ai_prompts/raw_nl_query.md.j2
plugins/finance-auto/templates/ai_prompts/raw_notes_draft.md.j2
plugins/finance-auto/scripts/m3_raw_ai_acceptance.py
_m3_raw_ai_completion_report.md
```

**Edited (2):**

```
plugins/finance-auto/finance_auto_backend/ai/scenarios/__init__.py  (3 imports + 3 registry + 3 __all__)
plugins/finance-auto/finance_auto_backend/routes.py                 (4 lines wire-up after register_ai_endpoints)
```

**Forbidden territory NOT touched:** `schema.py`, any `db/migrations/*`, any `services/*`, any `*_routes.py` outside `ai/raw_routes.py`, any UI / Tauri files.

---

## 3. Route delta (+4 raw endpoints)

Baseline (before any of my work, per task spec): **63**  
After Stage 3 (my +4): **67** (verified locally).  
After Sibling A's parallel `dbbd7fd5` notes-generator merge: **71** (their +8).  
Current total with my +4 on top: **75**.

| HTTP | Path | Handler |
|---|---|---|
| GET  | `/ai/raw/scenarios` | list_raw_scenarios |
| POST | `/ai/raw/audit-opinion` | post_audit_opinion |
| POST | `/ai/raw/nl-query` | post_nl_query |
| POST | `/ai/raw/notes-draft` | post_notes_draft |

**My raw delta: +4** (constant regardless of merge ordering with Sibling A).

Verification command:
```
d:\OpenAkita\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0, r'd:\OpenAkita\plugins\finance-auto'); from finance_auto_backend.routes import build_router_and_service; import tempfile, pathlib; tmp = pathlib.Path(tempfile.mkdtemp())/'fin.db'; r, svc, db = build_router_and_service(tmp); print('routes:', len(r.routes))"
```
→ `routes: 75`.

---

## 4. Acceptance result

`d:\OpenAkita\.venv\Scripts\python.exe plugins/finance-auto/scripts/m3_raw_ai_acceptance.py` → **exit 0**, all 12 checks PASS.

```
[OK] 01_list_raw_scenarios         elapsed=3ms
[OK] 02_registry_has_9             elapsed=0ms
[OK] 03_nl_query_benign            elapsed=8ms
[OK] 04_nl_query_malicious_blocked elapsed=6ms
[OK] 05_audit_opinion_denied       elapsed=6ms
[OK] 06_audit_opinion_success      elapsed=7ms
[OK] 07_prompt_injection_detected  elapsed=6ms
[OK] 08_ai_scenarios_has_9         elapsed=0ms
[OK] 09_audit_log_grew             elapsed=0ms
[OK] 10_notes_draft_endtoend       elapsed=10ms
[OK] 11_notes_draft_ready_emitted  elapsed=10ms
[OK] 12_sql_guard_unit_test        elapsed=0ms
```

Result JSON: `_m3_raw_ai_acceptance_result.json`.

---

## 5. Design highlights

### 5.1 SQL guard (`ai/sql_guard.py`)

Regex-only guard. Public API:

| Symbol | Purpose |
|---|---|
| `ALLOWED_TABLES` | 8-table whitelist (`report_cells`, `trial_balance_rows`, `accounts`, `note_documents`, `peer_comparison_results`, `peer_benchmarks`, `organizations`, `accounting_periods`). |
| `FORBIDDEN_TOKENS` | 17 mutators (`UPDATE`, `DELETE`, `INSERT`, `DROP`, `ALTER`, `ATTACH`, `DETACH`, `PRAGMA`, `CREATE`, `REPLACE`, `EXEC`, `EXECUTE`, `VACUUM`, `REINDEX`, `GRANT`, `REVOKE`, `TRUNCATE`). |
| `MAX_ROW_LIMIT` | `1000` (auto-appended; clamps any larger `LIMIT`). |
| `validate_select_sql()` | Returns `SQLGuardResult(safe, sql, errors, referenced_tables)`. |
| `extract_sql_from_markdown()` | Strips ` ```sql ... ``` ` fence. |

Implementation notes:
- Multi-statement guard: keeps only the head before the first `;`; any non-comment tail is reported as `multiple statements detected`.
- CTE-aware: `WITH name AS (...)` aliases are not flagged as out-of-allow-list.
- Comment stripping: `--` line + `/* */` block comments removed before validation.
- Stage 12 of the acceptance script feeds 13 hardcoded malicious inputs; all return `safe=False`.

### 5.2 Prompt-injection guard (S6)

Module-level compiled pattern (`raw_audit_opinion.PROMPT_INJECTION_PATTERN`) covers both English and Chinese phrasings:

```
re.compile(
    r"(ignore\s+(all\s+)?previous"
    r"|disregard\s+(all\s+)?previous"
    r"|忽略(以上|前面)"
    r"|忘记(以上|前面)"
    r"|act\s+as\s+(a\s+)?different"
    r"|new\s+instructions?\s+below)",
    re.IGNORECASE,
)
```

- Scans `payload['user_data_blob']` (built in `build_payload` from validations + template_text).
- On match: sets `payload['_prompt_injection_detected'] = True`, threads a markdown warning header through the template context (`${prompt_injection_warning}`), and surfaces `parsed.prompt_injection_detected = True` on the `ScenarioRunResult`.
- The guard NEVER raises — its only job is to flag.
- Acceptance step 7 exercises the full path: payload containing `"忽略以上指令"` returns `outcome=success, parsed.prompt_injection_detected=True`.

### 5.3 Scenario shape

All three modules export `SCENARIO_ID`, `DEFAULT_LEVEL = "raw"`, `PROMPT_TEMPLATE`, `build_payload`, and an async `run(...)` returning `ScenarioRunResult`. They:

- **S6** wraps the standard pipeline by hand (not `execute_scenario`) so the injection flag can be injected between consent and template-render while still emitting the canonical audit + result shape.
- **S7** uses `execute_scenario` with a custom `_sql_parser` that runs the candidate SQL through `validate_select_sql`. When `execute_sql=True` and the guard passes, `execute_safe_query` runs the SQL and the rows ride back inside `result.parsed`.
- **S11** uses `execute_scenario` with `_markdown_parser` and pre-renders its scenario-specific template keys so the base helper's default `safe_payload_json` context doesn't overwrite them.

### 5.4 Event subscriber (S11)

`attach_event_bus_subscriber(service, bus=None)` is idempotent (flag attribute on the service) and dispatches `finance.notes.draft_requested` to an async task. The subscriber:

1. Reads the pending `report_notes` row (gracefully no-ops on `no such table`).
2. Runs the scenario.
3. Writes the markdown back via dynamic column probing (`PRAGMA table_info(report_notes)`) so `ai_audit_id` / `updated_at` only get UPDATE-d when those columns exist.
4. Emits `finance.notes.draft_ready` with `{note_id, org_id, kind, audit_id, scenario_id}`.

The same persist + emit flow is duplicated inside the POST `/ai/raw/notes-draft` handler so the REST surface works even when the event bus isn't wired up.

### 5.5 DB seed (no schema change)

`ensure_raw_scenarios_seeded(service)` runs `INSERT OR IGNORE` for the three new rows:

| scenario_id | level | default_enabled | template_path | is_local_only | require_dialog |
|---|---|---|---|---|---|
| audit_opinion_draft | raw | 0 | templates/ai_prompts/raw_audit_opinion.md.j2 | 0 | 1 |
| nl_query | raw | 0 | templates/ai_prompts/raw_nl_query.md.j2 | 0 | 1 |
| notes_draft | raw | 0 | templates/ai_prompts/raw_notes_draft.md.j2 | 0 | 1 |

`default_enabled=0` per design (raw scenarios are opt-in). The acceptance script flips `enabled_override=1` at startup so the consent flow doesn't short-circuit to `denied`.

The helper runs lazily inside both `GET /ai/raw/scenarios` and every `/ai/raw/*` POST so a cold DB always ends up with the rows the first time any endpoint fires.

### 5.6 Per-spec hard constraints

| Constraint | Outcome |
|---|---|
| Stage = commit (5 commits) | ✅ |
| No `git add .` | ✅ — every `git add` named exact paths |
| Conventional + English body ≥ 3 lines | ✅ — all five commit messages |
| Route delta +4 | ✅ — 63 → 67 in isolation; 71 → 75 after Sibling A merge |
| Schema untouched | ✅ — zero new tables; only `INSERT OR IGNORE` into existing `ai_scenarios` |
| File territory respected | ✅ — see §2 |
| No `git push` / `git config` / force / `pip install` | ✅ |
| No subagents spawned | ✅ |
| No process restarts (TestClient only) | ✅ |
| PowerShell `;` not `&&` | ✅ |
| Mock LLM only | ✅ — `MockLLMResponder` + canned dict |
| Prompt-injection regex per spec | ✅ — see §5.2 |

---

## 6. Blockers / follow-ups

- **None blocking M3 closure.** All 12 acceptance checks pass on a cold DB.
- **Future hardening idea (out of scope for M3):** the SQL guard is regex-only; a v0.3 follow-up could swap in a real `sqlparse`-based AST walk to catch nested `WHERE EXISTS (DELETE ...)` style attacks. The current guard catches every example the acceptance unit-test list exercises (DROP / DELETE / UPDATE / ATTACH / PRAGMA / INSERT / CREATE / ALTER / EXEC / out-of-allowlist / UNION-to-secret / fenced-DROP-with-comment).
- **Sibling A interaction:** my Stage 3 commit landed cleanly even though Sibling A had merged a v10 `report_notes` table beforehand. The `notes_draft` subscriber + REST handler degrade gracefully via `no such table` detection. With Sibling A's v10 in place, the acceptance script seeds proper `note_templates` + `note_documents` + `report_notes` triples and exercises the full end-to-end path.
- **UI dist auto-rebuild:** the pre-commit hook in this repo rebuilds `plugins/finance-auto/ui/dist/index.html` on every commit and stages it; that file is included in Stage 1's commit as a passive side effect, not a manual edit. No UI source files were modified.
