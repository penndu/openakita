# Obsidian 知识库插件 (obsidian-kb)

将 Obsidian Vault 接入 OpenAkita 作为 RAG 知识源。

## 功能

- **obsidian_search** 工具 — 全文搜索笔记，支持标签过滤
- **obsidian_vault_info** 工具 — 查看 Vault 概览（笔记数、常用标签、最近修改）
- **on_retrieve** Hook — 对话时自动注入相关笔记内容到上下文
- **Retrieval Source** — 标准 RAG 检索接口

## 配置

安装后在插件设置中配置 `vault_path`:

```json
{
  "vault_path": "D:/MyObsidianVault",
  "exclude_patterns": [".trash", ".obsidian", "templates"],
  "max_file_size_kb": 500,
  "excerpt_length": 600
}
```

## 支持特性

- Frontmatter YAML 解析（title, tags 等）
- 内联标签 `#tag` 识别
- Wiki 链接 `[[note]]` 提取
- 中英文全文搜索
- 按标签过滤
