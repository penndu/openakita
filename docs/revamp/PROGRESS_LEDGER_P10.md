# Revamp Progress Ledger -- P-RC-10 (runtime/orgs -> orgs namespace flatten + 5 deferred nits + merge-to-main)

<!-- machine-readable phase marker; do NOT remove.
     Parsed by tests/revamp/_ledger.py + tests/parity/test_no_facade.py. -->
current_phase: P-RC-10

> **Sub-phase status (2026-05-21, P10.0a CHARTERED)**:
> P-RC-10 epic opened; this commit (the P10.0a charter
> ratification) is the first row below. P-RC-9 closed
> at G-RC-9 final eta-2 with 9 / 9 sentinels active +
> -35 493 LOC v1 retirement axis; 5 nits (M-2 / P9.7-B
> / epsilon-O1 / epsilon-O2 / GroupC) ride into P-RC-10
> per G-RC-9.9 section 3. Namespace flatten
> ``runtime/orgs/ -> orgs/`` is the primary axis (71
> files / 157 occurrences mechanically swept at P10.3).
> 308 shim retirement remains OUT-OF-SCOPE per ADR-0015
> option (b); deferred to v2.1.0 milestone.

> Source of truth for every commit landed on
> ``revamp/v3-orgs`` during the P-RC-10
> namespace-finalisation epic. One row per commit, in
> commit order. Each row is appended **in the same
> commit that produced it** (N3 from G-RC-1).
>
> This ledger is **separate** from
> ``docs/revamp/PROGRESS_LEDGER.md`` (frozen at
> P-RC-8) and ``docs/revamp/PROGRESS_LEDGER_P9.md``
> (closed at G-RC-9 eta-2). Keeping P-RC-10 in its own
> file preserves the per-epic clean diff lineage.
>
> Rules of the ledger (inherited from
> PROGRESS_LEDGER_P9):
> * append-only -- once a row lands it must not be
>   silently rewritten;
> * ``LOC delta`` and ``tests delta`` are signed
>   integers, positive = grew, negative = shrank,
>   ``0`` = unchanged;
> * ``ADR refs`` lists the ADRs whose sections the
>   commit implements (ADR-0011 / 0014 / 0015 are
>   P-RC-10-relevant; no new ADRs planned).

## P10.0 -- Charter ratification (paperwork)

| commit hash | phase | title | LOC delta | tests delta | ADR refs |
|---|---|---|---|---|---|
| _this commit_ | P-RC-10 P10.0a | docs(revamp): expand P-RC-10 charter with sub-phases, nits, merge-to-main plan [P-RC-10-charter] | +PLACEHOLDER (overwrite ``P-RC-10-CHARTER.md`` ~+420 + archive prior 220 LOC as ``.archived`` + new ``PROGRESS_LEDGER_P10.md`` ~+45) | 0 | --- (planning; cites ADR-0011 / 0014 / 0015 as references; no new ADR) |

> **Sub-phase status (2026-05-21, P10.0b RECON LANDED)**:
> P10.0b docs-only recon inventory landed.
> Measurements at HEAD ``52f8709a``: 25 v2 files
> (``runtime/orgs/``; LOC sum ~9 810) all relocate 1:1
> to ``orgs/`` at P10.1; 124 strict import sites across
> 63 files (M=122 / PT=0 / N=2 README.md citations);
> 104 doc citations (no rewrite in P10.3); 0 string-
> literal callers; P10.1 readiness verdict **GREEN**;
> P10.3 split refined to **5 mini-commits** (P10.3a..e)
> all within the 380-LOC envelope. See
> ``docs/revamp/P-RC-10-RECON.md``.

| commit hash | phase | title | LOC delta | tests delta | ADR refs |
|---|---|---|---|---|---|
| _this commit_ | P-RC-10 P10.0b | docs(revamp): P10.0b RECON import-sweep inventory + flatten mapping [P-RC-10 P10.0b] | +~365 (``P-RC-10-RECON.md`` ~351 + ``PROGRESS_LEDGER_P10.md`` append ~15) | 0 | --- (recon; cites ADR-0011 / 0014 / 0015 as references; no new ADR) |
## P10.1 -- Atomic flatten (runtime/orgs/* -> orgs/*)

> **Sub-phase status (2026-05-21, P10.1 LANDED + P10.2 LANDED)**:
> Atomic ``git mv`` of all 25 ``runtime/orgs/*.py`` files to
> ``src/openakita/orgs/`` (commit ``37536a62``); 1:1 rename per
> RECON section 1; 4 absolute self-import lines rewritten to
> relative form (manager.py x3 / _runtime_templates.py x1 per
> RECON section 3); 4 ins / 4 del net content delta (rename
> volume = 0 LOC). New canonical path
> ``openakita.orgs.X`` imports cleanly via the moved
> ``__init__.py``''s 21 relative re-export blocks.

| commit hash | phase | title | LOC delta | tests delta | ADR refs |
|---|---|---|---|---|---|
| ``37536a62`` | P-RC-10 P10.1 | refactor(orgs): atomic flatten src/openakita/runtime/orgs/* -> src/openakita/orgs/* (25 files) [P-RC-10 P10.1] | +4 / -4 (relative-form swaps; 25-file rename = 0 LOC) | 0 (test slice deliberately skipped between P10.1 and P10.2; green again after P10.2) | ADR-0011 (subsystem decomposition; no Protocol change) |

## P10.2 -- Backward-compat shim + sentinel #9 Option-Z relax

> **Sub-phase status (2026-05-21, P10.2 LANDED)**: Single new
> file ``src/openakita/runtime/orgs/__init__.py`` (~46 LOC)
> re-exports ``openakita.orgs.*`` via ``from openakita.orgs
> import *`` plus 24 ``sys.modules`` aliases (RECON section
> 4) so the 122/124 strict submodule-form import sites keep
> resolving. One-shot ``DeprecationWarning`` at first import
> (``stacklevel=2``); pytest config carries no
> ``filterwarnings=error`` so DeprecationWarnings surface in
> stderr without failing tests. Sentinel #9 Test 1
> (``test_v1_src_directory_retired``) augmented in place
> (Option Z) -- replaces the "MUST NOT exist" assertion with
> a structural marker check (post-flatten the dir MUST contain
> ``_runtime_templates.py`` etc., which the v1 layout never
> had) so the legitimate v2 occupancy is recognised while v1
> regrowth is still blocked. Test 2
> (``test_production_imports_v1_free``) untouched; the strict
> ``openakita.runtime.orgs.*`` augment rides P10.4 per charter.
> Narrow slice green: 262 parity+contracts / 192 runtime-orgs
> (== baseline). Backend boot smoke deferred (no IM gateway
> changes; HTTP routes already smoke-tested via the contracts
> slice).

| commit hash | phase | title | LOC delta | tests delta | ADR refs |
|---|---|---|---|---|---|
| _this commit_ | P-RC-10 P10.2 | feat(orgs): add openakita.runtime.orgs deprecation shim re-exporting from new location [P-RC-10 P10.2] | +~46 (shim) / +~20 / -~22 (sentinel #9 Test 1 Option-Z relax) / +~50 (this ledger block) -- net ~+95 | 0 (slice still 262 / 192) | ADR-0011 (subsystem decomposition; no Protocol change); ADR-0015 (308 shim retirement -- explicitly OUT-OF-SCOPE; byte-untouched) |

## P10.3a -- Sweep ``src/openakita/`` import sites to canonical ``openakita.orgs``

> **Sub-phase status (2026-05-21, P10.3a LANDED)**: Mechanical
> 1:1 prefix swap of every ``from|import openakita.runtime.orgs``
> line under ``src/openakita/`` (excl. the deliberate shim
> ``runtime/orgs/__init__.py``) to the post-flatten canonical
> ``openakita.orgs`` path. **31 sites across 12 files**: api
> 9 files / 23 sites (orgs_v2_runtime_orgs 7 + orgs_v2_runtime_projects 5
> + server 4 + orgs_v2_runtime_state 2 + chat / orgs_v2 /
> orgs_v2_runtime_dispatch / orgs_v2_runtime_nodes /
> orgs_v2_stream 1 each), channels 1 file / 6 sites
> (gateway.py), core 1 file / 1 site
> (_reasoning_engine_legacy.py), runtime 1 file / 1 site
> (channel_routing.py). RECON section 2.1 projected ``8 files /
> 31 sites``; the 12-file count reflects the same 31 sites plus
> the api-cluster row enumerated 5 files but conflated 4
> sibling routes with 1 site each into ``+ 1 sibling route``
> (recon row drift, not a new site). 1:1 byte-equivalent
> semantics; one isort-driven re-sort in
> ``runtime/channel_routing.py`` (the rewritten line moves up
> two slots in alphabetic block order). DeprecationWarning
> count from src/ paths drops 1 -> 0
> (``orgs_v2.py:55`` was the last src-side site emitting the
> shim warning). Slice expected on next sweep:
> ``test_v1_src_retired_sentinel.py::test_production_imports_v1_free``
> trips on the new ``from openakita.orgs.X`` lines because the
> sentinel's v1-era regex is now inverted post-flatten; charter
> section 2 P10.4 augment / regex inversion is the explicit
> remediation and MUST land before P10.3b to keep the slice
> green between mini-commits.

| commit hash | phase | title | LOC delta | tests delta | ADR refs |
|---|---|---|---|---|---|
| _this commit_ | P-RC-10 P10.3a | refactor(src/openakita): P10.3a sweep openakita.runtime.orgs imports to canonical openakita.orgs (31 sites / 12 files) [P-RC-10 P10.3a] | +31 / -31 (mechanical prefix swap) + ~5 ledger row | 261 parity+contracts (1 sentinel-#9 Test 2 break expected per inverted regex; P10.4 fix-forward) / 192 runtime-orgs (unchanged) | ADR-0011 (subsystem decomposition; no Protocol change) |