"""obsidian-kb: Obsidian Vault → RAG 知识源插件

功能:
  - obsidian_search 工具: 全文搜索 Vault 中的 Markdown 笔记
  - obsidian_vault_info 工具: 统计 Vault 概览（笔记数、标签、最近修改）
  - on_retrieve hook: 自动将相关笔记注入对话上下文
  - retrieval source: 标准 RAG 检索接口
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openakita.plugins.api import PluginAPI, PluginBase

logger = logging.getLogger(__name__)

_YAML_FRONT_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_TAG_INLINE_RE = re.compile(r"(?:^|\s)#([a-zA-Z\u4e00-\u9fff][\w\u4e00-\u9fff/\-]*)", re.MULTILINE)
_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")

DEFAULT_EXCLUDES = [".trash", ".obsidian", "templates", ".git", "node_modules"]


def _parse_frontmatter(text: str) -> dict[str, Any]:
    m = _YAML_FRONT_RE.match(text)
    if not m:
        return {}
    raw = m.group(1)
    fm: dict[str, Any] = {}
    for line in raw.split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key:
                if val.startswith("[") and val.endswith("]"):
                    fm[key] = [v.strip().strip('"').strip("'") for v in val[1:-1].split(",") if v.strip()]
                else:
                    fm[key] = val
    return fm


def _extract_tags(text: str, frontmatter: dict[str, Any]) -> list[str]:
    tags = set()
    fm_tags = frontmatter.get("tags", [])
    if isinstance(fm_tags, str):
        tags.update(t.strip() for t in fm_tags.split(",") if t.strip())
    elif isinstance(fm_tags, list):
        tags.update(str(t).strip() for t in fm_tags if str(t).strip())
    for m in _TAG_INLINE_RE.finditer(text):
        tags.add(m.group(1))
    return sorted(tags)


def _extract_wikilinks(text: str) -> list[str]:
    return list(dict.fromkeys(m.group(1) for m in _WIKILINK_RE.finditer(text)))


def _strip_frontmatter(text: str) -> str:
    m = _YAML_FRONT_RE.match(text)
    if m:
        return text[m.end():]
    return text


def _should_skip(path: Path, vault: Path, excludes: list[str]) -> bool:
    try:
        rel = path.relative_to(vault)
    except ValueError:
        return True
    parts = rel.parts
    for exc in excludes:
        for part in parts:
            if part == exc or part.startswith(exc):
                return True
    return False


class NoteIndex:
    """In-memory index of Vault notes for fast search."""

    def __init__(self) -> None:
        self.notes: list[dict[str, Any]] = []
        self._vault_path: str = ""
        self._built = False

    def build(self, vault_path: str, excludes: list[str] | None = None,
              max_size_kb: int = 500) -> None:
        vault = Path(vault_path)
        if not vault.is_dir():
            self.notes = []
            self._built = False
            return

        if self._built and self._vault_path == vault_path:
            return

        excludes = excludes or DEFAULT_EXCLUDES
        max_bytes = max_size_kb * 1024
        notes: list[dict[str, Any]] = []

        for md in sorted(vault.rglob("*.md")):
            if _should_skip(md, vault, excludes):
                continue
            try:
                stat = md.stat()
                if stat.st_size > max_bytes:
                    continue
                text = md.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            fm = _parse_frontmatter(text)
            body = _strip_frontmatter(text)
            tags = _extract_tags(text, fm)
            links = _extract_wikilinks(body)
            title = fm.get("title") or md.stem
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

            notes.append({
                "path": str(md.relative_to(vault)),
                "title": title,
                "tags": tags,
                "links": links,
                "body": body,
                "body_lower": body.lower(),
                "mtime": mtime,
                "size": stat.st_size,
            })

        self.notes = notes
        self._vault_path = vault_path
        self._built = True
        logger.info("obsidian-kb: indexed %d notes from %s", len(notes), vault_path)

    def invalidate(self) -> None:
        self._built = False

    def search(self, query: str, limit: int = 5, tag: str = "",
               excerpt_len: int = 600) -> list[dict[str, Any]]:
        q = (query or "").strip().lower()
        if not q and not tag:
            return []

        tokens = [t for t in re.split(r"[\s\W]+", q) if len(t) > 1] if q else []

        results: list[dict[str, Any]] = []
        for note in self.notes:
            if tag and tag not in note["tags"]:
                continue

            hay = note["body_lower"]
            score = 0.0

            if q and q in hay:
                score += 0.6
            if q and q in note["title"].lower():
                score += 0.3

            for t in tokens[:10]:
                if t in hay:
                    score += 0.08
                if t in note["title"].lower():
                    score += 0.15

            if tag and tag in note["tags"]:
                score += 0.2

            if score <= 0:
                continue

            body_clean = note["body"].strip().replace("\n", " ")
            if q:
                idx = hay.find(q)
                if idx >= 0:
                    start = max(0, idx - 80)
                    excerpt = body_clean[start:start + excerpt_len]
                else:
                    excerpt = body_clean[:excerpt_len]
            else:
                excerpt = body_clean[:excerpt_len]

            results.append({
                "id": note["path"],
                "title": note["title"],
                "content": f"## {note['title']}\n{excerpt}",
                "tags": note["tags"],
                "links": note["links"][:10],
                "mtime": note["mtime"],
                "relevance": round(min(score, 1.0), 3),
            })

        ranked = sorted(results, key=lambda x: -x["relevance"])
        return ranked[:limit]

    def vault_info(self) -> dict[str, Any]:
        if not self.notes:
            return {"total_notes": 0, "tags": [], "recent": []}

        all_tags: dict[str, int] = {}
        for n in self.notes:
            for t in n["tags"]:
                all_tags[t] = all_tags.get(t, 0) + 1

        top_tags = sorted(all_tags.items(), key=lambda x: -x[1])[:30]
        recent = sorted(self.notes, key=lambda x: x["mtime"], reverse=True)[:10]

        total_size = sum(n["size"] for n in self.notes)
        return {
            "total_notes": len(self.notes),
            "total_size_mb": round(total_size / 1024 / 1024, 2),
            "top_tags": [{"tag": t, "count": c} for t, c in top_tags],
            "recent_notes": [
                {"path": n["path"], "title": n["title"], "mtime": n["mtime"]}
                for n in recent
            ],
        }


class ObsidianRetriever:
    source_name = "obsidian"

    def __init__(self, index: NoteIndex, get_config: Any) -> None:
        self._index = index
        self._get_config = get_config

    async def retrieve(self, query: str, limit: int = 5) -> list[dict]:
        cfg = self._get_config()
        vault = (cfg.get("vault_path") or "").strip()
        if not vault:
            return []
        self._index.build(
            vault,
            excludes=cfg.get("exclude_patterns", DEFAULT_EXCLUDES),
            max_size_kb=cfg.get("max_file_size_kb", 500),
        )
        return self._index.search(
            query, limit=limit,
            excerpt_len=cfg.get("excerpt_length", 600),
        )


class Plugin(PluginBase):
    def __init__(self) -> None:
        self._api: PluginAPI | None = None
        self._index = NoteIndex()

    def on_load(self, api: PluginAPI) -> None:
        self._api = api
        retriever = ObsidianRetriever(self._index, api.get_config)

        api.register_retrieval_source(retriever)

        async def inject_knowledge(**kwargs: Any) -> str:
            query = str(
                kwargs.get("query")
                or kwargs.get("enhanced_query")
                or kwargs.get("user_query")
                or ""
            )
            chunks = await retriever.retrieve(query, limit=3)
            if not chunks:
                return ""
            lines = []
            for c in chunks:
                body = (c.get("content") or "")[:500]
                if body:
                    lines.append(body)
            if not lines:
                return ""
            return "\n<!-- obsidian-kb -->\n" + "\n\n".join(lines) + "\n"

        api.register_hook("on_retrieve", inject_knowledge)

        search_def = {
            "type": "function",
            "function": {
                "name": "obsidian_search",
                "description": (
                    "在用户配置的 Obsidian Vault 中搜索 Markdown 笔记。"
                    "Search Markdown notes in the Obsidian vault. "
                    "Supports full-text search and optional tag filtering."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词 / Search query",
                        },
                        "tag": {
                            "type": "string",
                            "description": "按标签过滤 / Filter by tag (without #)",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回结果数量上限 / Max results (default 5)",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

        vault_info_def = {
            "type": "function",
            "function": {
                "name": "obsidian_vault_info",
                "description": (
                    "获取 Obsidian Vault 概览信息：笔记总数、常用标签、最近修改的笔记。"
                    "Get Obsidian vault overview: note count, top tags, recently modified notes."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
        }

        async def tool_handler(tool_name: str, params: dict) -> str:
            cfg = api.get_config()
            vault = (cfg.get("vault_path") or "").strip()
            if not vault:
                return "请先配置 vault_path / Please configure vault_path first in plugin settings."

            self._index.build(
                vault,
                excludes=cfg.get("exclude_patterns", DEFAULT_EXCLUDES),
                max_size_kb=cfg.get("max_file_size_kb", 500),
            )

            if tool_name == "obsidian_search":
                query = str(params.get("query", ""))
                tag = str(params.get("tag", ""))
                lim = int(params.get("limit", 5))
                results = self._index.search(
                    query, limit=lim, tag=tag,
                    excerpt_len=cfg.get("excerpt_length", 600),
                )
                if not results:
                    return f"未找到匹配 '{query}' 的笔记 / No matching notes found."
                parts = []
                for r in results:
                    tag_str = " ".join(f"#{t}" for t in r.get("tags", [])[:5])
                    parts.append(
                        f"📄 **{r['title']}** (relevance: {r['relevance']:.2f})\n"
                        f"   Path: {r['id']} | Tags: {tag_str or 'none'}\n"
                        f"   {r.get('content', '')[:400]}"
                    )
                return "\n\n".join(parts)

            if tool_name == "obsidian_vault_info":
                info = self._index.vault_info()
                if info["total_notes"] == 0:
                    return "Vault 为空或路径无效 / Vault is empty or path is invalid."
                tag_lines = ", ".join(
                    f"#{t['tag']}({t['count']})" for t in info["top_tags"][:15]
                )
                recent_lines = "\n".join(
                    f"  - {n['title']} ({n['mtime'][:10]})" for n in info["recent_notes"]
                )
                return (
                    f"📚 Vault 概览\n"
                    f"笔记总数: {info['total_notes']}\n"
                    f"总大小: {info['total_size_mb']} MB\n"
                    f"常用标签: {tag_lines}\n"
                    f"最近修改:\n{recent_lines}"
                )

            return ""

        api.register_tools([search_def, vault_info_def], tool_handler)
        api.log(f"obsidian-kb v1.1.0 loaded, 2 tools + retrieval source registered", "info")

    def on_unload(self) -> None:
        self._index.invalidate()
        self._api = None
