"""
媒体解析器：从回复文本中提取图片/文件引用

参考 openclaw-china-main packages/shared/src/media/media-parser.ts

支持的格式：
- Markdown 图片: ![alt](path_or_url)
- MEDIA: 指令行: MEDIA: /path/to/file
- 裸本地路径（以已知图片/文件扩展名结尾的绝对路径独占一行）

解析后返回清理过的文本和提取出的媒体路径列表。
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"}
FILE_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".txt", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".mp3", ".wav", ".ogg", ".mp4", ".avi", ".mov", ".mkv",
}

MEDIA_LINE_PREFIX = "MEDIA:"

_MAX_PATH_LENGTH = 1024

_RE_MARKDOWN_IMAGE = re.compile(
    r"!\[([^\]]*)\]\(([^)\s]+)\)",
)

_RE_BARE_LOCAL_PATH = re.compile(
    r"^[ \t]*([A-Za-z]:[/\\][^\n]+|/[^\n]+)$",
    re.MULTILINE,
)


@dataclass
class ExtractedMedia:
    path: str
    is_url: bool = False
    media_type: str = "file"


@dataclass
class MediaParseResult:
    cleaned_text: str = ""
    images: list[ExtractedMedia] = field(default_factory=list)
    files: list[ExtractedMedia] = field(default_factory=list)


class PathSecurityError(Exception):
    def __init__(self, path: str, reason: str):
        self.path = path
        self.reason = reason
        super().__init__(f"Path security violation: {reason} ({path})")


def validate_path_security(
    file_path: str,
    allowed_prefixes: list[str] | None = None,
    max_path_length: int = _MAX_PATH_LENGTH,
) -> None:
    if len(file_path) > max_path_length:
        raise PathSecurityError(
            file_path,
            f"Path length {len(file_path)} exceeds maximum {max_path_length}",
        )

    normalized = os.path.normpath(file_path)
    if ".." in normalized.split(os.sep):
        raise PathSecurityError(file_path, "Path traversal detected")

    if allowed_prefixes:
        norm_lower = normalized.lower().replace("\\", "/")
        if not any(
            norm_lower.startswith(p.lower().replace("\\", "/"))
            for p in allowed_prefixes
        ):
            raise PathSecurityError(
                file_path,
                f"Path not under allowed prefixes: {allowed_prefixes}",
            )


def is_http_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def _classify_by_extension(path_str: str) -> str:
    ext = Path(path_str).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return "file"


def parse_media_from_text(
    text: str | None,
    *,
    remove_from_text: bool = True,
    allowed_prefixes: list[str] | None = None,
    parse_markdown_images: bool = True,
    parse_media_lines: bool = True,
    parse_bare_paths: bool = True,
) -> MediaParseResult:
    """从文本中解析并提取媒体引用。

    Args:
        text: 待解析文本
        remove_from_text: 是否从返回文本中移除已提取的媒体引用
        allowed_prefixes: 本地路径白名单前缀（None 表示不限制）
        parse_markdown_images: 是否解析 ![alt](path) 格式
        parse_media_lines: 是否解析 MEDIA: 行
        parse_bare_paths: 是否解析独占一行的裸绝对路径

    Returns:
        MediaParseResult 包含 cleaned_text、images、files
    """
    if not text:
        return MediaParseResult()

    result = MediaParseResult()
    seen: set[str] = set()
    cleaned = text

    def _try_add(source: str) -> bool:
        """尝试添加媒体项（去重 + 安全校验）"""
        key = source.lower().replace("\\", "/")
        if key in seen:
            return False
        seen.add(key)

        is_url = is_http_url(source)
        media_type = _classify_by_extension(source)

        if not is_url:
            try:
                validate_path_security(source, allowed_prefixes)
            except PathSecurityError as e:
                logger.warning(f"Media path rejected: {e}")
                return False

        media = ExtractedMedia(path=source, is_url=is_url, media_type=media_type)
        if media_type == "image":
            result.images.append(media)
        else:
            result.files.append(media)
        return True

    # 1. 解析 MEDIA: 指令行
    if parse_media_lines:
        lines = cleaned.split("\n")
        kept_lines: list[str] = []
        for line in lines:
            trimmed = line.strip()
            if trimmed.upper().startswith(MEDIA_LINE_PREFIX):
                payload = trimmed[len(MEDIA_LINE_PREFIX):].strip()
                if payload and _try_add(payload) and remove_from_text:
                    continue
            kept_lines.append(line)
        if remove_from_text:
            cleaned = "\n".join(kept_lines)

    # 2. 解析 Markdown 图片 ![alt](path)
    if parse_markdown_images:
        def _md_replacer(m: re.Match) -> str:
            source = m.group(2)
            if _try_add(source) and remove_from_text:
                return ""
            return m.group(0)
        cleaned = _RE_MARKDOWN_IMAGE.sub(_md_replacer, cleaned)

    # 3. 解析裸本地路径（独占一行的绝对路径，以已知扩展名结尾）
    if parse_bare_paths:
        def _bare_replacer(m: re.Match) -> str:
            candidate = m.group(1).strip()
            ext = Path(candidate).suffix.lower()
            if ext not in IMAGE_EXTENSIONS and ext not in FILE_EXTENSIONS:
                return m.group(0)
            if _try_add(candidate) and remove_from_text:
                return ""
            return m.group(0)
        cleaned = _RE_BARE_LOCAL_PATH.sub(_bare_replacer, cleaned)

    # 清理连续空行
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    result.cleaned_text = cleaned

    return result
