"""v2 OrgBlackboard scaffold (P-RC-9 P9.1a).

Replaces v1 ``openakita.orgs.blackboard.OrgBlackboard`` (344
LOC, 19 methods) with a Protocol-typed, backend-pluggable v2
surface. P9.1a ships the **scaffold** -- read + write per scope
plus ``clear`` -- against the default
:class:`JsonFileBlackboardBackend`. Eviction, dup detection,
ttl expiry, ``query``, ``delete_entry``, the
``get_*_summary`` helpers, the :class:`SqliteBlackboardBackend`,
and the ``get_default_blackboard`` factory all land in P9.1b
("complete v2 OrgBlackboard with concurrency + schema
validation").

ADR refs: ADR-0011 (Protocol-typed subsystem decomposition),
ADR-0012 (orgs/ deletion strategy -- no shim under
``src/openakita/orgs/`` once P9.9 runs).
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol, runtime_checkable

from .memory_models import MemoryScope, MemoryType, OrgMemoryEntry

__all__ = [
    "BlackboardBackendProtocol",
    "JsonFileBlackboardBackend",
    "MAX_DEPT_MEMORIES",
    "MAX_NODE_MEMORIES",
    "MAX_ORG_MEMORIES",
    "OrgBlackboard",
]

logger = logging.getLogger(__name__)

# Per-scope soft caps -- v1 constants preserved verbatim (parity
# tests in P9.1c gate the eviction behaviour built on top of them).
MAX_ORG_MEMORIES = 200
MAX_DEPT_MEMORIES = 100
MAX_NODE_MEMORIES = 50


def _safe_int(v: object, default: int) -> int:
    """v1 ``_safe_int`` clone; coerces model-emitted ``"10"`` / ``10.0``."""
    try:
        value = int(float(v))
    except (ValueError, TypeError):
        return default
    return value if value > 0 else default


@runtime_checkable
class BlackboardBackendProtocol(Protocol):
    """Storage abstraction for :class:`OrgBlackboard` (ADR-0011)."""

    def append(
        self,
        scope: MemoryScope,
        owner: str,
        entry: OrgMemoryEntry,
        *,
        max_entries: int,
    ) -> None:
        """Persist *entry*; backends MUST evict to honour ``max_entries``."""

    def all_for_scope(
        self, scope: MemoryScope, *, owner: str | None = None
    ) -> list[OrgMemoryEntry]:
        """Every entry for ``scope`` (optionally narrowed to ``owner``)."""

    def is_duplicate(
        self, scope: MemoryScope, owner: str, content: str, *, prefix_len: int = 100
    ) -> bool:
        """True iff an entry whose content shares the first ``prefix_len`` chars exists."""

    def delete_by_id(self, memory_id: str) -> bool:
        """Remove entry with id ``memory_id``; True iff found."""

    def read(
        self,
        scope: MemoryScope,
        owner: str,
        *,
        limit: int = 20,
        tag: str | None = None,
    ) -> list[OrgMemoryEntry]:
        """Up to ``limit`` entries for (scope, owner), most-important first."""

    def clear(self) -> None:
        """Wipe every entry across every scope."""

    def close(self) -> None:
        """Release backend resources. Idempotent."""


class JsonFileBlackboardBackend:
    """Per-scope JSONL files under ``<org_dir>/memory/...`` (mirrors v1).

    Layout:

    * ``<org_dir>/memory/blackboard.jsonl`` -- ORG scope.
    * ``<org_dir>/memory/departments/<dept>.jsonl`` -- DEPARTMENT.
    * ``<org_dir>/memory/nodes/<node_id>.jsonl`` -- NODE.

    ``threading.RLock`` serialises append + read within the
    process. Cross-process safety is deferred to
    :class:`SqliteBlackboardBackend` (P9.1b).
    """

    def __init__(self, org_dir: Path, org_id: str) -> None:
        self._org_dir = Path(org_dir)
        self._org_id = org_id
        self._memory_dir = self._org_dir / "memory"
        self._memory_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path_for(self, scope: MemoryScope, owner: str) -> Path:
        if scope == MemoryScope.ORG:
            return self._memory_dir / "blackboard.jsonl"
        if scope == MemoryScope.DEPARTMENT:
            return self._memory_dir / "departments" / f"{owner}.jsonl"
        return self._memory_dir / "nodes" / f"{owner}.jsonl"

    def append(
        self,
        scope: MemoryScope,
        owner: str,
        entry: OrgMemoryEntry,
        *,
        max_entries: int,
    ) -> None:
        path = self._path_for(scope, owner)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        self._evict_if_needed(path, max_entries)

    def is_duplicate(
        self,
        scope: MemoryScope,
        owner: str,
        content: str,
        *,
        prefix_len: int = 100,
    ) -> bool:
        path = self._path_for(scope, owner)
        prefix = content[:prefix_len].strip()
        if not prefix or not path.is_file():
            return False
        with self._lock:
            raw = path.read_text(encoding="utf-8")
        for line in raw.strip().splitlines():
            if not line.strip():
                continue
            try:
                existing = json.loads(line).get("content", "")
            except (json.JSONDecodeError, AttributeError):
                continue
            if isinstance(existing, str) and existing[:prefix_len].strip() == prefix:
                return True
        return False

    def all_for_scope(
        self, scope: MemoryScope, *, owner: str | None = None
    ) -> list[OrgMemoryEntry]:
        out: list[OrgMemoryEntry] = []
        if scope == MemoryScope.ORG:
            out.extend(self.read(MemoryScope.ORG, self._org_id, limit=10_000))
            return out
        sub = "departments" if scope == MemoryScope.DEPARTMENT else "nodes"
        d = self._memory_dir / sub
        if not d.exists():
            return out
        for f in sorted(d.glob("*.jsonl")):
            if owner and f.stem != owner:
                continue
            out.extend(self.read(scope, f.stem, limit=10_000))
        return out

    def delete_by_id(self, memory_id: str) -> bool:
        with self._lock:
            for path in self._all_memory_files():
                if not path.is_file():
                    continue
                lines = path.read_text(encoding="utf-8").splitlines()
                kept: list[str] = []
                found = False
                for line in lines:
                    if not line.strip():
                        continue
                    try:
                        if json.loads(line).get("id") == memory_id:
                            found = True
                            continue
                    except (json.JSONDecodeError, AttributeError):
                        pass
                    kept.append(line)
                if found:
                    path.write_text(
                        ("\n".join(kept) + "\n") if kept else "", encoding="utf-8"
                    )
                    return True
        return False

    def _all_memory_files(self) -> list[Path]:
        files: list[Path] = []
        org_path = self._memory_dir / "blackboard.jsonl"
        if org_path.exists():
            files.append(org_path)
        for sub in ("departments", "nodes"):
            d = self._memory_dir / sub
            if d.exists():
                files.extend(sorted(d.glob("*.jsonl")))
        return files

    @staticmethod
    def _is_expired(entry: OrgMemoryEntry) -> bool:
        if not entry.ttl_hours:
            return False
        try:
            created = datetime.fromisoformat(entry.created_at.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return False
        expiry = created + timedelta(hours=entry.ttl_hours)
        return datetime.now(created.tzinfo) > expiry

    def _evict_if_needed(self, path: Path, max_entries: int) -> None:
        if not path.is_file():
            return
        with self._lock:
            lines = [
                ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()
            ]
            live: list[tuple[float, str]] = []
            for line in lines:
                try:
                    entry = OrgMemoryEntry.from_dict(json.loads(line))
                except (json.JSONDecodeError, ValueError, TypeError):
                    continue
                if self._is_expired(entry):
                    continue
                live.append((entry.importance, line))
            if len(live) <= max_entries and len(live) == len(lines):
                return
            live.sort(key=lambda x: x[0], reverse=True)
            kept = live[:max_entries]
            path.write_text("\n".join(ln for _, ln in kept) + "\n", encoding="utf-8")

    def read(
        self,
        scope: MemoryScope,
        owner: str,
        *,
        limit: int = 20,
        tag: str | None = None,
    ) -> list[OrgMemoryEntry]:
        path = self._path_for(scope, owner)
        limit = _safe_int(limit, 20)
        with self._lock:
            if not path.is_file():
                return []
            try:
                raw = path.read_text(encoding="utf-8")
            except OSError as exc:
                logger.warning("[Blackboard] read failed for %s: %s", path, exc)
                return []
        entries: list[OrgMemoryEntry] = []
        for line in raw.strip().splitlines():
            if not line.strip():
                continue
            try:
                entry = OrgMemoryEntry.from_dict(json.loads(line))
            except (json.JSONDecodeError, ValueError, TypeError) as exc:
                logger.debug("[Blackboard] dropping malformed row: %s", exc)
                continue
            if self._is_expired(entry):
                continue
            if tag and tag not in entry.tags:
                continue
            entries.append(entry)
        entries.sort(key=lambda e: e.importance, reverse=True)
        return entries[:limit]

    def clear(self) -> None:
        import shutil

        with self._lock:
            if self._memory_dir.exists():
                shutil.rmtree(self._memory_dir, ignore_errors=True)
            self._memory_dir.mkdir(parents=True, exist_ok=True)

    def close(self) -> None:
        return None


class OrgBlackboard:
    """v2 three-tier shared memory; sync API matches v1 verbatim."""

    def __init__(
        self,
        org_dir: Path,
        org_id: str,
        *,
        backend: BlackboardBackendProtocol | None = None,
    ) -> None:
        self._org_dir = Path(org_dir)
        self._org_id = org_id
        if backend is None:
            backend = JsonFileBlackboardBackend(self._org_dir, org_id)
        self._backend = backend

    def clear(self) -> None:
        """Wipe all blackboard memory for the org. Mirrors v1."""
        logger.warning("[Blackboard] Clearing ALL memory for org %s", self._org_id)
        self._backend.clear()

    # ---- read ----------------------------------------------------------

    def read_org(self, limit: int = 20, tag: str | None = None) -> list[OrgMemoryEntry]:
        return self._backend.read(MemoryScope.ORG, self._org_id, limit=limit, tag=tag)

    def read_department(
        self, dept_name: str, limit: int = 20, tag: str | None = None
    ) -> list[OrgMemoryEntry]:
        return self._backend.read(
            MemoryScope.DEPARTMENT, dept_name, limit=limit, tag=tag
        )

    def read_node(
        self, node_id: str, limit: int = 20, tag: str | None = None
    ) -> list[OrgMemoryEntry]:
        return self._backend.read(MemoryScope.NODE, node_id, limit=limit, tag=tag)

    # ---- write ---------------------------------------------------------

    def write_org(
        self,
        content: str,
        source_node: str,
        memory_type: MemoryType = MemoryType.FACT,
        tags: list[str] | None = None,
        importance: float = 0.5,
        source_message_id: str | None = None,
        attachments: list[dict] | None = None,
    ) -> OrgMemoryEntry | None:
        entry = OrgMemoryEntry(
            org_id=self._org_id,
            scope=MemoryScope.ORG,
            scope_owner=self._org_id,
            memory_type=memory_type,
            content=content,
            source_node=source_node,
            source_message_id=source_message_id,
            tags=tags or [],
            importance=importance,
            attachments=attachments or [],
        )
        if self._backend.is_duplicate(MemoryScope.ORG, self._org_id, content):
            logger.debug("[Blackboard] skip duplicate org entry: %r", content[:50])
            return None
        self._backend.append(
            MemoryScope.ORG, self._org_id, entry, max_entries=MAX_ORG_MEMORIES
        )
        return entry

    def write_department(
        self,
        dept_name: str,
        content: str,
        source_node: str,
        memory_type: MemoryType = MemoryType.FACT,
        tags: list[str] | None = None,
        importance: float = 0.5,
    ) -> OrgMemoryEntry | None:
        entry = OrgMemoryEntry(
            org_id=self._org_id,
            scope=MemoryScope.DEPARTMENT,
            scope_owner=dept_name,
            memory_type=memory_type,
            content=content,
            source_node=source_node,
            tags=tags or [],
            importance=importance,
        )
        if self._backend.is_duplicate(MemoryScope.DEPARTMENT, dept_name, content):
            logger.debug("[Blackboard] skip duplicate dept entry: %r", content[:50])
            return None
        self._backend.append(
            MemoryScope.DEPARTMENT, dept_name, entry, max_entries=MAX_DEPT_MEMORIES
        )
        return entry

    def write_node(
        self,
        node_id: str,
        content: str,
        memory_type: MemoryType = MemoryType.FACT,
        tags: list[str] | None = None,
        importance: float = 0.5,
    ) -> OrgMemoryEntry:
        entry = OrgMemoryEntry(
            org_id=self._org_id,
            scope=MemoryScope.NODE,
            scope_owner=node_id,
            memory_type=memory_type,
            content=content,
            source_node=node_id,
            tags=tags or [],
            importance=importance,
        )
        self._backend.append(
            MemoryScope.NODE, node_id, entry, max_entries=MAX_NODE_MEMORIES
        )
        return entry


    # ---- query / delete / summaries -----------------------------------

    def query(
        self,
        scope: MemoryScope | None = None,
        scope_owner: str | None = None,
        memory_type: MemoryType | None = None,
        tag: str | None = None,
        limit: int = 50,
    ) -> list[OrgMemoryEntry]:
        """Cross-scope query with optional filters; most-recent first."""
        limit = _safe_int(limit, 50)
        all_entries: list[OrgMemoryEntry] = []
        if scope is None or scope == MemoryScope.ORG:
            all_entries.extend(self._backend.all_for_scope(MemoryScope.ORG))
        if scope is None or scope == MemoryScope.DEPARTMENT:
            all_entries.extend(
                self._backend.all_for_scope(
                    MemoryScope.DEPARTMENT, owner=scope_owner
                )
            )
        if scope is None or scope == MemoryScope.NODE:
            all_entries.extend(
                self._backend.all_for_scope(MemoryScope.NODE, owner=scope_owner)
            )
        if memory_type:
            all_entries = [e for e in all_entries if e.memory_type == memory_type]
        if tag:
            all_entries = [e for e in all_entries if tag in e.tags]
        all_entries.sort(key=lambda e: e.created_at, reverse=True)
        return all_entries[:limit]

    def delete_entry(self, memory_id: str) -> bool:
        """Delete a memory entry by id; True iff found in any scope."""
        return self._backend.delete_by_id(memory_id)

    def get_org_summary(self, max_entries: int = 10) -> str:
        entries = self.read_org(limit=max_entries)
        if not entries:
            return "(???????)"
        return "\n".join(
            f"- [{e.memory_type.value}] {e.content}"
            + (f" [{', '.join(e.tags)}]" if e.tags else "")
            for e in entries
        )

    def get_dept_summary(self, dept_name: str, max_entries: int = 5) -> str:
        entries = self.read_department(dept_name, limit=max_entries)
        if not entries:
            return f"({dept_name} ???????)"
        return "\n".join(
            f"- [{e.memory_type.value}] {e.content}" for e in entries
        )

    def get_node_summary(self, node_id: str, max_entries: int = 5) -> str:
        entries = self.read_node(node_id, limit=max_entries)
        if not entries:
            return "(??????)"
        return "\n".join(f"- {e.content}" for e in entries)
