---
name: word-maker
description: Guided Word document generation for editable DOCX reports, proposals, minutes, contracts, SOPs, and enterprise templates.
---

# word-maker Skill Card

Use this plugin when the user asks to create, revise, audit, or export a Word
document. Prefer it over ad-hoc DOCX scripts when the task needs guided
requirements, source files, template variables, section iteration, or a
downloadable editable DOCX.

## Tool Order

1. `word_start_project`
2. `word_ingest_sources` when files or notes are provided
3. `word_upload_template` and `word_extract_template_vars` when a template is used
4. `word_generate_outline`
5. `word_confirm_outline`
6. `word_fill_template`
7. `word_audit`
8. `word_export`

Do not claim a document is generated unless `word_export` returns a real output
path. Ask the user to confirm missing template fields instead of silently
leaving them blank.

