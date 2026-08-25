# Cursor Integration

## Install

```bash
# From a local checkout
npm install && npm run build
npm link -w toknt   # optional: puts \`toknt\` on your PATH
toknt install cursor
```

This does three things:

1. Writes hook scripts under `~/.cursor/toknt/hooks/`
2. Registers them in **`~/.cursor/hooks.json`** (`postToolUse` + Shell `preToolUse`)
3. Copies the bundled plugin to `~/.cursor/plugins/toknt`

Restart Cursor (or wait for hooks reload) after install.

## How It Works

Cursor hooks use the native stdin/stdout JSON protocol:

| Hook | Behavior |
|------|----------|
| `preToolUse` (Shell) | In `balanced` / `aggressive` mode, wraps the shell command so stdout/stderr are compressed before the model sees them |
| `postToolUse` | Quietly caches/stats optimizations; rewrites model-visible output only for MCP (`updated_mcp_tool_output`). Does **not** inject `additional_context` (that would stack on top of the real tool result) |

Original content stays in `~/.toknt/` and can be recalled via `toknt://` URIs.

## Plugin

The Cursor plugin at `plugins/cursor/` (copied on install) includes:

- **Hooks** — reference scripts (runtime hooks come from `toknt install`)
- **Skills** — `toknt-optimize` for recall commands
- **Rules** — `toknt-recall` for compressed content handling

## Verify

```bash
toknt status
toknt doctor
```

Look for:

- `Cursor integration: Active`
- `Cursor hooks.json: Tokn't postToolUse/preToolUse registered`
- `Cursor plugin: ~/.cursor/plugins/toknt`

## Uninstall

```bash
toknt uninstall
```

Removes `~/.cursor/toknt/`, Tokn't entries from `hooks.json`, and `~/.cursor/plugins/toknt`.
