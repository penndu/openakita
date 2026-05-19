"""v2 ``OrgManager`` (P-RC-9 P9.5).

Replaces v1 ``openakita.orgs.manager.OrgManager`` (683 LOC,
24 public methods + ``OrgNameConflictError``) with a
:class:`typing.Protocol`-typed v2 surface under
``runtime/orgs/``. Implements
:class:`openakita.runtime.orgs.command_service.OrgLookupProtocol`
(REUSE from P9.4) so P9.4 ``OrgCommandService`` can consume
the v2 manager structurally once P9.8 redirects callers.

Protocol decomposition (G-RC-9.4 auditor recommendation #4:
<= 5 methods per Protocol; 4 Protocols total):

* :class:`OrgLookupProtocol` (REUSED from
  ``command_service.py``) -- 1 method ``get_org`` --
  implemented by :class:`OrgManager` directly.
* :class:`OrgPersistenceProtocol` (NEW DI) -- 4 methods
  (``load_org_dict`` / ``save_org_dict`` / ``delete_org_dir``
  / ``list_org_ids``). Default backend ships in this file as
  :class:`_FilesystemOrgPersistence`, byte-for-byte
  parity-faithful with v1 (same ``data/orgs/<id>/org.json``
  path, same ``.tmp`` + ``os.replace`` atomic write).
* :class:`OrgLifecycleEmitterProtocol` (NEW DI, no-op
  default) -- 3 methods (``emit_org_created`` /
  ``emit_org_updated`` / ``emit_org_deleted``). v1 only
  ``logger.info``s lifecycle events; the no-op default
  preserves that behaviour so existing callers see no
  emission. v2 callers (e.g., future
  ``ChannelGatewayProtocol`` re-broadcast) can inject a real
  emitter without touching ``OrgManager`` internals.
* :class:`OrgFactoryProtocol` (NEW DI) -- 2 methods
  (``new_org_id`` / ``initialize_directory_layout``).
  Default backend = v1 ``_new_id("org_")`` + v1
  ``_init_dirs`` body lifted byte-for-byte.

Commit split (Nit-4 fold-in): P9.5a0 (layout helpers,
landed); P9.5a (this commit; Protocols + scaffold);
P9.5b/P9.5b2 (OrgManager bodies); P9.5c (parity);
P9.5d (contract); G-RC-9.5 (mini-gate).
ADR refs: ADR-0011 (Protocol-typed subsystem decomposition;
4 Protocols all <= 5 methods); ADR-0012 (no shim under v1).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from openakita.orgs.models import Organization, _new_id

from .command_service import OrgLookupProtocol

__all__ = [
    "OrgFactoryProtocol",
    "OrgLifecycleEmitterProtocol",
    "OrgLookupProtocol",
    "OrgManager",
    "OrgNameConflictError",
    "OrgPersistenceProtocol",
    "get_org_manager",
]

logger = logging.getLogger(__name__)

# v1 ``manager._init_dirs`` README body (Chinese; user-facing). Lifted
# verbatim so the persisted ``policies/README.md`` is byte-equal
# across v1 and v2 (P-RC-9-PLAN section 5.2 dir-layout parity).
_POLICIES_README_TEMPLATE = (
    "# \u5236\u5ea6\u7d22\u5f15\n\n"
    "> \u672c\u6587\u4ef6\u7531\u7cfb\u7edf\u81ea\u52a8\u7ef4\u62a4\n\n"
    "| \u6587\u4ef6 | \u4e3b\u9898 | \u9002\u7528\u8303\u56f4 | \u751f\u6548\u65e5 |\n"
    "|------|------|---------|--------|\n"
)


# ---------------------------------------------------------------------------
# Protocols (ADR-0011; 4 Protocols, each <= 5 methods)
# ---------------------------------------------------------------------------


@runtime_checkable
class OrgPersistenceProtocol(Protocol):
    """Backend for org main-document storage (``org.json`` per org).

    Lifts the four v1 filesystem operations behind a
    duck-typed surface so future SQLite / cloud backends can
    swap in. Default = :class:`_FilesystemOrgPersistence`
    (parity-faithful ``.tmp`` + ``os.replace`` writes).
    """

    def load_org_dict(self, org_id: str) -> dict[str, Any] | None: ...
    def save_org_dict(self, org_id: str, data: dict[str, Any]) -> None: ...
    def delete_org_dir(self, org_id: str) -> bool: ...
    def list_org_ids(self) -> list[str]: ...


@runtime_checkable
class OrgLifecycleEmitterProtocol(Protocol):
    """Optional hook for org-level lifecycle events.

    v1 only ``logger.info``s lifecycle changes -- the no-op
    default preserves that behaviour. Real emitters (future
    Org<->IM bridge) opt in via the constructor.
    """

    def emit_org_created(self, org_id: str, name: str) -> None: ...
    def emit_org_updated(self, org_id: str) -> None: ...
    def emit_org_deleted(self, org_id: str) -> None: ...


@runtime_checkable
class OrgFactoryProtocol(Protocol):
    """Org-ID minting + initial directory layout.

    Lets tests stub id-generation deterministically and lets
    sandboxed runs override the directory tree. Default =
    :class:`_DefaultOrgFactory` (v1 ``_new_id("org_")`` +
    ``_init_dirs`` body).
    """

    def new_org_id(self) -> str: ...
    def initialize_directory_layout(self, org_dir: Path, org: Organization) -> None: ...


# ---------------------------------------------------------------------------
# Default backends (ship in this file so the DI fallback wiring is one line)
# ---------------------------------------------------------------------------


class _FilesystemOrgPersistence:
    """Default :class:`OrgPersistenceProtocol` impl.

    Atomic ``.tmp`` + ``os.replace`` writes guarded by a
    :class:`threading.Lock` (matches v1 ``OrgManager._save``).
    """

    def __init__(self, orgs_dir: Path) -> None:
        self._orgs_dir = Path(orgs_dir)
        self._write_lock = threading.Lock()

    def _org_dir(self, org_id: str) -> Path:
        if ".." in org_id or "/" in org_id or "\\" in org_id:
            raise ValueError(f"Invalid org_id: {org_id}")
        return self._orgs_dir / org_id

    def load_org_dict(self, org_id: str) -> dict[str, Any] | None:
        p = self._org_dir(org_id) / "org.json"
        if not p.is_file():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def save_org_dict(self, org_id: str, data: dict[str, Any]) -> None:
        p = self._org_dir(org_id) / "org.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        payload = json.dumps(data, ensure_ascii=False, indent=2)
        with self._write_lock:
            tmp.write_text(payload, encoding="utf-8")
            os.replace(str(tmp), str(p))

    def delete_org_dir(self, org_id: str) -> bool:
        d = self._org_dir(org_id)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def list_org_ids(self) -> list[str]:
        if not self._orgs_dir.exists():
            return []
        return [p.name for p in sorted(self._orgs_dir.iterdir()) if (p / "org.json").is_file()]


class _NoopOrgLifecycleEmitter:
    """No-op default for :class:`OrgLifecycleEmitterProtocol`.

    Preserves v1 behaviour (no event emission). Real emitters
    are opt-in via ``OrgManager(..., lifecycle=my_emitter)``.
    """

    def emit_org_created(self, org_id: str, name: str) -> None: ...
    def emit_org_updated(self, org_id: str) -> None: ...
    def emit_org_deleted(self, org_id: str) -> None: ...


class _DefaultOrgFactory:
    """Default :class:`OrgFactoryProtocol` impl.

    ``new_org_id`` delegates to v1 ``_new_id("org_")`` so
    existing fixtures match. ``initialize_directory_layout``
    lifts the v1 ``OrgManager._init_dirs`` body verbatim so
    the P-RC-9-PLAN section 5.2 dir-layout parity assertion
    holds.
    """

    _SUBDIRS: tuple[str, ...] = (
        "nodes",
        "policies",
        "departments",
        "memory",
        "memory/departments",
        "memory/nodes",
        "events",
        "logs",
        "logs/tasks",
        "reports",
        "artifacts",
        "artifacts/meetings",
    )

    def new_org_id(self) -> str:
        return _new_id("org_")

    def initialize_directory_layout(self, org_dir: Path, org: Organization) -> None:
        for sub in self._SUBDIRS:
            (org_dir / sub).mkdir(parents=True, exist_ok=True)
        readme = org_dir / "policies" / "README.md"
        if not readme.exists():
            readme.write_text(_POLICIES_README_TEMPLATE, encoding="utf-8")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class OrgNameConflictError(ValueError):
    """Raised by ``create`` / ``update`` / ``duplicate`` on a name collision.

    v2 alias for v1 ``openakita.orgs.manager.OrgNameConflictError``;
    the v2 attribute shape (``name`` + ``conflict_org_id``) is
    byte-for-byte identical so REST handlers that map this to
    HTTP 409 keep working unchanged.
    """

    def __init__(self, name: str, conflict_org_id: str) -> None:
        super().__init__(f"Organization name already exists: {name!r}")
        self.name = name
        self.conflict_org_id = conflict_org_id


# ---------------------------------------------------------------------------
# OrgManager (scaffold; bodies land in P9.5b / P9.5b2)
# ---------------------------------------------------------------------------


class OrgManager:
    """Organisation CRUD + persistence + cache (v2; P-RC-9 P9.5).

    Construct with ``data_dir`` (the same data root v1 reads)
    plus three optional DI Protocols. Default fallbacks wire
    in the parity-faithful filesystem backend so a one-arg
    ``OrgManager(data_dir)`` behaves like v1.

    Concurrency: a single :class:`threading.Lock` (matches v1
    ``OrgManager._write_lock``) guards the in-memory cache.
    Public methods are SYNC -- callers in ``api/routes/`` are
    FastAPI sync handlers; an async lock would force every
    caller to ``await`` and break v1 caller parity.
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        persistence: OrgPersistenceProtocol | None = None,
        lifecycle: OrgLifecycleEmitterProtocol | None = None,
        factory: OrgFactoryProtocol | None = None,
    ) -> None:
        self._data_dir = Path(data_dir)
        self._orgs_dir = self._data_dir / "orgs"
        self._templates_dir = self._data_dir / "org_templates"
        self._orgs_dir.mkdir(parents=True, exist_ok=True)
        self._templates_dir.mkdir(parents=True, exist_ok=True)
        self._persistence: OrgPersistenceProtocol = (
            persistence if persistence is not None else _FilesystemOrgPersistence(self._orgs_dir)
        )
        self._lifecycle: OrgLifecycleEmitterProtocol = (
            lifecycle if lifecycle is not None else _NoopOrgLifecycleEmitter()
        )
        self._factory: OrgFactoryProtocol = factory if factory is not None else _DefaultOrgFactory()
        self._cache: dict[str, Organization] = {}
        self._write_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Directory helpers (parity-faithful with v1 ``manager._*``)
    # ------------------------------------------------------------------

    def _org_dir(self, org_id: str) -> Path:
        if ".." in org_id or "/" in org_id or "\\" in org_id:
            raise ValueError(f"Invalid org_id: {org_id}")
        return self._orgs_dir / org_id

    def _org_json(self, org_id: str) -> Path:
        return self._org_dir(org_id) / "org.json"

    def _state_json(self, org_id: str) -> Path:
        return self._org_dir(org_id) / "state.json"

    def _node_dir(self, org_id: str, node_id: str) -> Path:
        return self._org_dir(org_id) / "nodes" / node_id

    def _schedules_json(self, org_id: str, node_id: str) -> Path:
        return self._node_dir(org_id, node_id) / "schedules.json"

    def get_org_dir(self, org_id: str) -> Path:
        """Public alias for ``_org_dir`` (used by command_service / api).

        Callers that need the org root path on disk should
        use this method rather than reaching into the private
        helper. The path is validated for traversal-safety.
        """
        return self._org_dir(org_id)

    # ------------------------------------------------------------------
    # OrgLookupProtocol (P9.4 ``command_service.OrgLookupProtocol``)
    # ------------------------------------------------------------------

    def get_org(self, org_id: str) -> Organization | None:
        """Implements :class:`OrgLookupProtocol` from P9.4 command_service.

        Cache-bypass read via the injected persistence
        backend (so a freshly-saved org from another process
        is visible). ``get(org_id)`` -- landing in P9.5b --
        will be the cached-read variant.
        """
        raw = self._persistence.load_org_dict(org_id)
        if raw is None:
            return None
        return Organization.from_dict(raw)


# ---------------------------------------------------------------------------
# Factory helper (P-RC-9-PLAN section 4 P9.5)
# ---------------------------------------------------------------------------


def get_org_manager(data_dir: Path) -> OrgManager:
    """Module-level factory matching the P-RC-9-PLAN section 4 P9.5 surface.

    Returns a fresh :class:`OrgManager` bound to ``data_dir``
    with all default DI backends. Equivalent to
    ``OrgManager(data_dir)`` but spelled out so the caller-
    facing import surface mirrors v1's
    ``openakita.orgs.manager.OrgManager`` factory pattern.
    """
    return OrgManager(data_dir)
