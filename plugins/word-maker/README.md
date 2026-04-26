# Word Maker

Guided Word document generation for editable DOCX reports, proposals, minutes,
contracts, SOPs, and enterprise templates.

This plugin follows the same self-contained UI/runtime pattern as
`plugins/avatar-studio`: frontend assets live under `ui/dist/`, helpers are
vendored under `word_maker_inline/`, and project data is stored under
`api.get_data_dir()/word-maker/`.

## MVP Modes

- `topic_to_doc`: generate a document from guided requirements.
- `files_to_doc`: generate from source files, Markdown, URLs, and notes.
- `template_doc`: fill an enterprise DOCX template after variable validation.
- `revise_doc`: revise an existing project or a single section.
- `brief_to_ppt`: prepare a structured summary for future PPT generation.

## Smoke Test

1. Load the plugin.
2. Open the UI and check the Health panel.
3. Call `word_list_projects`.
4. Confirm the response states that project storage is ready after Phase 1.

