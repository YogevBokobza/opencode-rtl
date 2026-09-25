# opencode-rtl

Comprehensive right-to-left language support for opencode. The plugin improves mixed RTL/LTR conversations in terminal sessions while preserving code, commands, file paths, logs, and other technical text.

## Features

- Adds model guidance for Arabic, Persian, Hebrew, Urdu, Pashto, Sindhi, Yiddish, Divehi, Uyghur, and Kurdish workflows.
- Detects RTL text with Unicode script ranges and language-specific hints.
- Wraps RTL prose with Unicode bidirectional isolates so nearby LTR tokens stay readable.
- Optionally hard-wraps and pads RTL paragraphs so wrapped lines remain visually right-aligned in opencode's TUI.
- Leaves fenced code blocks and indented code untouched.
- Optionally normalizes Arabic-Indic, Eastern Arabic, or Latin digits.
- Exposes TUI commands for plugin status and RTL detection checks.
- Exports reusable text utilities for custom opencode plugins.

## Install

### OpenCode V2 and OpenChamber

The package root and `/server` entrypoints expose a default definition with an `id` and `setup()` for V2. The same definition retains `server()` for V1.

V2 supports RTL system guidance, isolation of user text in outgoing model context, optional tool-result text formatting, and shell environment settings. User isolation does not rewrite saved prompts or attachment offsets.

V2 has no equivalent of V1's `experimental.text.complete` hook. `isolateAssistantText` therefore does not post-process generated replies on V2. Assistant hard-wrapping, padding, digit conversion, and HTML wrappers are also unavailable there. Tool-output formatting can still use these options when enabled. The `/tui` entrypoint, status commands, and startup toast remain V1-only. OpenChamber owns its message layout and input direction.

The V2 adapter is typechecked against `@opencode/plugin` 2.0.16. It uses type-only imports, so the installed plugin has no runtime SDK dependency.

### From npm

For V2, add the plugin to `opencode.json` or `~/.config/opencode/opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-rtl"]
}
```

For V1, use `"plugin": ["opencode-rtl"]` instead.

### With options

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-rtl",
      "options": {
        "language": "auto",
        "systemGuidance": true,
        "isolateUserMessages": "auto",
        "isolateAssistantText": "auto",
        "isolateToolOutput": "off",
        "digitMode": "preserve",
        "alignRtlParagraphs": false,
        "rtlWrapColumn": 96,
        "rtlAlignColumn": 96
      }
    }
  ]
}
```

### Local development

This repository includes `opencode.json` so opencode can load the plugin from the project during development.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "./dist", "options": { "language": "auto" } }]
}
```

Build the plugin before loading the local directory:

```sh
npm ci
npm run build
```

Reload the plugin in your client after rebuilding. Check its plugin list for `opencode-rtl` and confirm that it has no load error. If the installed npm version still reports "Plugin must export a default definition with an id and an effect or setup function", point the configuration to this checkout's `dist` directory until a compatible package is published. V2 local plugin paths must name a directory containing `server.js` or `index.js`, not an individual file.

For V1, keep the legacy `"plugin": [["opencode-rtl", { "language": "auto" }]]` configuration syntax.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enables all plugin behavior. |
| `language` | `"auto" \| "none" \| RTL language code` | `"auto"` | Auto-detects or forces the RTL language context. |
| `systemGuidance` | `boolean \| string` | `true` | Adds built-in guidance or a custom system prompt. |
| `isolateUserMessages` | `"off" \| "auto" \| "always" \| boolean` | `"auto"` | Applies Unicode bidi isolation to user text sent to models. |
| `isolateAssistantText` | `"off" \| "auto" \| "always" \| boolean` | `"auto"` | V1 only. Applies Unicode bidi isolation to generated assistant text. |
| `isolateToolOutput` | `"off" \| "auto" \| "always" \| boolean` | `"off"` | Applies isolation to tool output. Keep off if exact copy/paste matters. |
| `minRtlRatio` | `number` | `0.2` | Minimum RTL character ratio for automatic RTL detection. |
| `minRtlCharacters` | `number` | `2` | Minimum RTL characters needed for automatic detection. |
| `digitMode` | `"preserve" \| "latin" \| "arabic-indic" \| "eastern-arabic"` | `"preserve"` | Optional digit conversion outside code blocks. |
| `forceDirection` | `"auto" \| "rtl" \| "ltr"` | `"auto"` | Forces bidi isolate direction when automatic detection is not enough. |
| `alignRtlParagraphs` | `boolean` | `false` | Terminal-only hard-wrap/padding workaround. This is not the RTL detection switch. |
| `rtlWrapColumn` | `number` | `96` | Maximum visual width before the plugin inserts real line breaks. |
| `rtlAlignColumn` | `number` | `96` | Visual column used for right padding. Match this to your opencode message width. |
| `wrapRtlMarkdown` | `"off" \| "auto" \| "always"` | `"off"` | Experimental output-only Markdown wrapper for renderers that honor inline HTML. Keep off for normal use. |
| `directionEnv` | `boolean` | `true` | Exposes RTL settings to shell tools through `OPENCODE_RTL_*` env vars. |
| `includeLanguageHint` | `boolean` | `true` | Adds an explicit language-context line to the system guidance. |
| `notifyOnStart` | `boolean` | `false` | V1 TUI only. Shows a toast when the plugin loads. |
| `debug` | `boolean` | `false` | Logs initialization through `client.app.log()` on V1 and `console.info()` on V2. |

Supported language codes: `ar`, `fa`, `he`, `ur`, `ps`, `sd`, `yi`, `dv`, `ug`, `ku`.

## V1 TUI Commands

Open the command palette and run:

- `RTL: Show Status` to display active options.
- `RTL: Analyze Sample` to verify direction and language detection.

## Direction Detection

The plugin treats mixed text as RTL when at least `minRtlCharacters` RTL characters are present and the RTL ratio is at least `minRtlRatio`. With the default `minRtlRatio: 0.2`, a paragraph that is mostly Persian with some English identifiers, paths, or package names is still handled as RTL.

```json
{
  "minRtlRatio": 0.2,
  "minRtlCharacters": 2,
  "forceDirection": "auto"
}
```

Use `forceDirection: "rtl"` only if you want every formatted assistant/user text segment to be treated as RTL regardless of detected content.

## V1 Web Layout

`opencode web` controls the prompt input and outer message column in its own UI. Without changing opencode itself, the plugin can only influence text after it leaves or enters model hooks. Optionally set `wrapRtlMarkdown: "auto"` to wrap each detected RTL output paragraph in an inline HTML paragraph:

```html
<p dir="rtl" align="right">
RTL block only
</p>
```

LTR paragraphs and fenced code blocks are left unchanged. This option is disabled by default because inline HTML wrappers can interact poorly with some Markdown renderers. If live typing in the Ask Anything box is wrong, the fix must be upstream in opencode's Web UI prompt component.

## V1 Terminal Alignment

opencode's terminal TUI can render soft-wrapped RTL text with correct paragraph direction but left alignment on continuation lines. Enable `alignRtlParagraphs` only for terminal TUI output, not for `opencode web`, because it inserts real line breaks and padding spaces into assistant text.

```json
{
  "alignRtlParagraphs": true,
  "rtlWrapColumn": 96,
  "rtlAlignColumn": 96
}
```

Tune `rtlAlignColumn` to the visible message width in your terminal. If the padded lines start too far left, increase it; if they overflow or wrap again, decrease it. Keep this option off for Web UI because it inserts real spacing into the message text.

## Troubleshooting

If it looks like nothing changed:

- Start opencode from this repository, or pass the project path explicitly: `opencode /path/to/opencode-rtl`.
- On V2, check the client's plugin list for a loaded `opencode-rtl`. On V1, confirm project config with `opencode debug config`; do not share the full output because it can include provider API keys.
- On V1 TUI, look for the `RTL support loaded` toast on startup when `notifyOnStart` or `debug` is enabled.
- On V1, if automatic detection is too subtle, set `forceDirection` to `"rtl"` and `isolateAssistantText` to `"always"` in `opencode.json`. On V2, keep `systemGuidance` enabled and set `language` to your RTL language code for explicit model guidance; assistant layout remains client-controlled.
- On V1, if RTL continuation lines appear left-aligned in terminal TUI, enable `alignRtlParagraphs` and tune `rtlAlignColumn` for your terminal width.
- If you use `opencode web`, prompt/input alignment is controlled by opencode's Web UI. This plugin cannot change that without an upstream opencode web change.
- If you use terminal TUI and mean the prompt cursor/input direction, that is controlled by opencode's TUI and your terminal, not by server-side plugin hooks.

## How It Works

opencode plugins cannot replace the terminal renderer or the host terminal font. This plugin uses the supported plugin hooks to improve RTL behavior safely:

On V2:

- Session hooks for `context`, `compaction`, `generate`, and `title` add system guidance and isolate text parts of user messages in outgoing requests.
- `tool.hook("execute.after")` optionally formats successful tool-result text, preserving structured output, file attachments, metadata, and failures.
- `shell.hook("create.before")` exposes `OPENCODE_RTL_*` settings. `OPENCODE_RTL_ASSISTANT_ISOLATION` is `off` because V2 cannot post-process assistant text.
- OpenCode disposes these hook registrations when the plugin unloads.

On V1:

- `experimental.chat.system.transform` injects RTL-aware response instructions.
- `chat.message` isolates RTL user message parts before model calls.
- `experimental.chat.messages.transform` keeps historical user message parts stable during context transforms.
- `experimental.text.complete` isolates assistant prose after generation.
- `tool.execute.after` can isolate tool output when explicitly enabled.
- `shell.env` exposes `OPENCODE_RTL`, `OPENCODE_RTL_LANGUAGE`, `OPENCODE_RTL_USER_ISOLATION`, and `OPENCODE_RTL_ASSISTANT_ISOLATION`.

The formatter skips fenced code blocks and indented code because invisible bidi controls inside source code, shell commands, or logs can make copying unsafe.

## Development

```sh
npm install
npm run typecheck
npm test
```

## Package Entrypoints

- `opencode-rtl/server` default-exports the V1/V2 server plugin definition.
- `opencode-rtl/tui` exports the V1 TUI plugin module.
- `opencode-rtl` default-exports the same server definition, plus named reusable utilities and V1 plugin functions.

## Limitations

- Terminal shaping, glyph fallback, cursor movement, and input method behavior still depend on your terminal emulator and font.
- The opencode prompt/input widget is not replaced by this plugin; terminal cursor movement for RTL typing still depends on the TUI and terminal.
- The browser prompt/input in `opencode web` is rendered by opencode's Web UI. The current plugin API does not expose a supported hook to change its DOM direction or alignment.
- Unicode isolation improves display order but intentionally does not rewrite code, logs, paths, or command output by default.
- If exact text copy/paste is more important than visual ordering, set `isolateAssistantText` to `"off"`.
