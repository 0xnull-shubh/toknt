import { access, cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BaseAdapter, type AgentInfo, type ToolOutput, OptimizingAdapterWrapper } from '@toknt/adapters';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Matches both legacy ~/.cursor/toknt/hooks and canonical ~/.cursor/hooks/toknt-* */
const TOKNT_CMD_MARKERS = ['toknt/hooks/', 'hooks/toknt-', 'toknt-shell-wrap', 'toknt-post-tool', 'toknt-pre-tool', 'toknt-after-shell'];

function resolveAdaptersEntry(): string {
  try {
    return fileURLToPath(import.meta.resolve('@toknt/adapters'));
  } catch {
    return join(HERE, '../../../packages/adapters/dist/index.js');
  }
}

function isTokntHookCommand(command: string): boolean {
  return TOKNT_CMD_MARKERS.some((m) => command.includes(m));
}

export class CursorAdapter extends BaseAdapter {
  readonly name = 'cursor';
  private wrapper: OptimizingAdapterWrapper;

  constructor() {
    super();
    this.wrapper = new OptimizingAdapterWrapper();
  }

  async detect(): Promise<AgentInfo> {
    const configPath = join(homedir(), '.cursor');
    let installed = false;
    try {
      await access(configPath);
      installed = true;
    } catch {
      // not installed
    }
    return { name: 'Cursor', installed, configPath };
  }

  async install(): Promise<void> {
    const cursorDir = join(homedir(), '.cursor');
    const userHooksDir = join(cursorDir, 'hooks');
    const metaDir = join(cursorDir, 'toknt');
    await mkdir(userHooksDir, { recursive: true });
    await mkdir(metaDir, { recursive: true });

    const adaptersEntry = resolveAdaptersEntry();

    const postPath = join(userHooksDir, 'toknt-post-tool-use.mjs');
    const prePath = join(userHooksDir, 'toknt-pre-tool-use.mjs');
    const wrapPath = join(userHooksDir, 'toknt-shell-wrap.mjs');
    const afterShellPath = join(userHooksDir, 'toknt-after-shell.mjs');

    await writeFile(postPath, buildPostToolUseHook(adaptersEntry), { mode: 0o755 });
    await writeFile(prePath, buildPreToolUseHook(wrapPath), { mode: 0o755 });
    await writeFile(wrapPath, buildShellWrapHook(adaptersEntry), { mode: 0o755 });
    await writeFile(afterShellPath, buildAfterShellHook(adaptersEntry), { mode: 0o755 });
    await Promise.all([postPath, prePath, wrapPath, afterShellPath].map((p) => chmod(p, 0o755)));

    // Keep a copy under ~/.cursor/toknt for doctor/status detection + metadata
    await writeFile(
      join(metaDir, 'toknt.json'),
      JSON.stringify(
        {
          version: '1.0.0',
          provider: 'toknt',
          hooks: {
            postToolUse: './hooks/toknt-post-tool-use.mjs',
            preToolUse: './hooks/toknt-pre-tool-use.mjs',
            afterShellExecution: './hooks/toknt-after-shell.mjs',
          },
          adaptersEntry,
        },
        null,
        2
      )
    );

    // User hooks run from ~/.cursor — use relative paths Cursor documents.
    await mergeCursorHooksJson(cursorDir, {
      postToolUse: './hooks/toknt-post-tool-use.mjs',
      preToolUse: './hooks/toknt-pre-tool-use.mjs',
      afterShellExecution: './hooks/toknt-after-shell.mjs',
    });

    await installCursorPlugin(cursorDir);
  }

  async uninstall(): Promise<void> {
    const cursorDir = join(homedir(), '.cursor');
    await removeTokntHooks(cursorDir);
    const hooksDir = join(cursorDir, 'hooks');
    for (const name of [
      'toknt-post-tool-use.mjs',
      'toknt-pre-tool-use.mjs',
      'toknt-shell-wrap.mjs',
      'toknt-after-shell.mjs',
    ]) {
      await rm(join(hooksDir, name), { force: true });
    }
    await rm(join(cursorDir, 'toknt'), { recursive: true, force: true });
    await rm(join(cursorDir, 'plugins', 'toknt'), { recursive: true, force: true });
  }

  async interceptToolOutput(output: ToolOutput): Promise<ToolOutput> {
    return this.wrapper.processToolOutput(output);
  }

  getWrapper(): OptimizingAdapterWrapper {
    return this.wrapper;
  }
}

async function mergeCursorHooksJson(
  cursorDir: string,
  commands: { postToolUse: string; preToolUse: string; afterShellExecution: string }
): Promise<void> {
  const hooksPath = join(cursorDir, 'hooks.json');
  let config: { version: number; hooks: Record<string, Array<{ command: string; matcher?: string }>> } = {
    version: 1,
    hooks: {},
  };

  try {
    config = JSON.parse(await readFile(hooksPath, 'utf-8'));
    if (!config.hooks) config.hooks = {};
    if (!config.version) config.version = 1;
  } catch {
    // create fresh
  }

  const stripToknt = (hooks: Array<{ command: string; matcher?: string }> = []) =>
    hooks.filter((h) => !isTokntHookCommand(h.command));

  config.hooks.postToolUse = [...stripToknt(config.hooks.postToolUse), { command: commands.postToolUse }];
  config.hooks.preToolUse = [
    ...stripToknt(config.hooks.preToolUse),
    { command: commands.preToolUse, matcher: 'Shell' },
  ];
  config.hooks.afterShellExecution = [
    ...stripToknt(config.hooks.afterShellExecution),
    { command: commands.afterShellExecution },
  ];

  await writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeTokntHooks(cursorDir: string): Promise<void> {
  const hooksPath = join(cursorDir, 'hooks.json');
  try {
    const config = JSON.parse(await readFile(hooksPath, 'utf-8')) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    for (const key of Object.keys(config.hooks ?? {})) {
      config.hooks[key] = (config.hooks[key] ?? []).filter((h) => !isTokntHookCommand(h.command));
      if (config.hooks[key].length === 0) delete config.hooks[key];
    }
    if (Object.keys(config.hooks).length === 0) {
      await rm(hooksPath, { force: true });
    } else {
      await writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  } catch {
    // nothing to remove
  }
}

async function installCursorPlugin(cursorDir: string): Promise<void> {
  const dest = join(cursorDir, 'plugins', 'toknt');
  const candidates = [
    join(HERE, '../../../plugins/cursor'),
    join(process.cwd(), 'plugins/cursor'),
  ];

  for (const src of candidates) {
    try {
      await access(src);
      await rm(dest, { recursive: true, force: true });
      await mkdir(join(cursorDir, 'plugins'), { recursive: true });
      await cp(src, dest, { recursive: true });
      return;
    } catch {
      // try next
    }
  }
}

function buildPostToolUseHook(adaptersEntry: string): string {
  return `#!/usr/bin/env node
/**
 * Quiet postToolUse: cache/stats only. Rewrite model output only for MCP.
 */
import { pathToFileURL } from 'node:url';

const adaptersEntry = ${JSON.stringify(adaptersEntry)};
const { OptimizingAdapterWrapper } = await import(pathToFileURL(adaptersEntry).href);
const wrapper = new OptimizingAdapterWrapper();

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function extractContent(toolOutput) {
  if (toolOutput == null) return '';
  if (typeof toolOutput === 'string') {
    try {
      const parsed = JSON.parse(toolOutput);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.stdout === 'string') return parsed.stdout;
        if (typeof parsed.output === 'string') return parsed.output;
        if (typeof parsed.content === 'string') return parsed.content;
      }
    } catch {
      return toolOutput;
    }
    return toolOutput;
  }
  if (typeof toolOutput === 'object') {
    if (typeof toolOutput.stdout === 'string') return toolOutput.stdout;
    if (typeof toolOutput.output === 'string') return toolOutput.output;
    if (typeof toolOutput.content === 'string') return toolOutput.content;
    return JSON.stringify(toolOutput);
  }
  return String(toolOutput);
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stdout.write('{}\\n');
    process.exit(0);
  }

  const event = JSON.parse(raw);
  const toolName = event.tool_name ?? event.toolName ?? event.tool ?? 'unknown';
  const content = extractContent(event.tool_output ?? event.output);
  if (!content) {
    process.stdout.write('{}\\n');
    process.exit(0);
  }

  if (
    content.includes('Full output stored locally.') ||
    content.includes('[UNCHANGED FILE]') ||
    content.startsWith('TEST RESULT')
  ) {
    process.stdout.write('{}\\n');
    process.exit(0);
  }

  const path =
    event.tool_input?.path ??
    event.tool_input?.file_path ??
    event.path ??
    event.file_path;

  const optimized = await wrapper.processToolOutput({
    toolName,
    content,
    path,
    metadata: event.metadata,
  });

  const meta = optimized.metadata?.toknt;
  const isMcp =
    typeof event.mcp_server_name === 'string' || String(toolName).startsWith('MCP:');

  if (meta?.optimized && isMcp) {
    let updated;
    try {
      updated = JSON.parse(optimized.content);
    } catch {
      updated = { content: optimized.content, toknt: meta };
    }
    process.stdout.write(JSON.stringify({ updated_mcp_tool_output: updated }) + '\\n');
    process.exit(0);
  }

  process.stdout.write('{}\\n');
} catch (err) {
  process.stderr.write('[toknt] postToolUse hook error: ' + (err?.message ?? err) + '\\n');
  process.stdout.write('{}\\n');
}
`;
}

function buildPreToolUseHook(shellWrapPath: string): string {
  return `#!/usr/bin/env node
/**
 * Wrap only heavy test/build Shell commands. Pass command as a single --cmd argv
 * so # comments / newlines cannot break the wrap (unlike \`node wrap -- \$cmd\`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const shellWrapPath = ${JSON.stringify(shellWrapPath)};
const nodeBin = ${JSON.stringify(process.execPath)};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function shouldWrap(command) {
  if (!command || typeof command !== 'string') return false;
  if (command.includes('toknt-shell-wrap')) return false;
  // Only known noisy test/build runners — never wrap arbitrary shell.
  return /\\b(npm\\s+test|npm\\s+run\\s+test|npx\\s+vitest|npx\\s+jest|yarn\\s+test|pnpm\\s+test|pytest|python\\s+-m\\s+pytest|cargo\\s+test|go\\s+test|mvn\\s+test|gradlew?\\s+test|ctest)\\b/i.test(
    command
  );
}

async function getMode() {
  try {
    const raw = await readFile(join(homedir(), '.toknt', 'config.json'), 'utf-8');
    return JSON.parse(raw).mode ?? 'safe';
  } catch {
    return 'safe';
  }
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\\n');
    process.exit(0);
  }

  const event = JSON.parse(raw);
  const toolName = event.tool_name ?? event.toolName ?? '';
  const isShell = toolName === 'Shell' || /shell/i.test(toolName);
  const command = event.tool_input?.command ?? event.command ?? '';
  const mode = await getMode();

  if (!isShell || mode === 'safe' || !shouldWrap(command)) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\\n');
    process.exit(0);
  }

  const wrapped =
    nodeBin + ' ' + JSON.stringify(shellWrapPath) + ' --cmd ' + JSON.stringify(command);

  process.stdout.write(
    JSON.stringify({
      permission: 'allow',
      updated_input: {
        ...(event.tool_input ?? {}),
        command: wrapped,
      },
    }) + '\\n'
  );
} catch (err) {
  process.stderr.write('[toknt] preToolUse hook error: ' + (err?.message ?? err) + '\\n');
  process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\\n');
}
`;
}

function buildShellWrapHook(adaptersEntry: string): string {
  return `#!/usr/bin/env node
/**
 * Runs a shell command from --cmd and prints optimized stdout when safe.
 * Always fail-open: on any error, still try to run the original command.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const adaptersEntry = ${JSON.stringify(adaptersEntry)};

function getCmd() {
  const idx = process.argv.indexOf('--cmd');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const sep = process.argv.indexOf('--');
  if (sep >= 0) return process.argv.slice(sep + 1).join(' ');
  return '';
}

const command = getCmd();
if (!command) {
  process.stderr.write('[toknt] shell-wrap: missing --cmd; pass-through impossible\\n');
  process.exit(0);
}

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, env: process.env, cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (c) => resolve({ code: c ?? 0, stdout, stderr }));
  });
}

const { code, stdout, stderr } = await run(command);
const combined = stderr ? stdout + (stdout ? '\\n' : '') + stderr : stdout;

try {
  const { OptimizingAdapterWrapper } = await import(pathToFileURL(adaptersEntry).href);
  const wrapper = new OptimizingAdapterWrapper();
  const optimized = await wrapper.processToolOutput({
    toolName: 'Shell',
    content: combined,
  });
  const meta = optimized.metadata?.toknt;
  // Only replace when we clearly compressed terminal/test output
  if (meta?.optimized && meta.strategy === 'terminal_output') {
    process.stdout.write(optimized.content);
    if (!optimized.content.endsWith('\\n')) process.stdout.write('\\n');
  } else {
    process.stdout.write(combined);
  }
} catch {
  process.stdout.write(combined);
}

process.exit(code);
`;
}

function buildAfterShellHook(adaptersEntry: string): string {
  return `#!/usr/bin/env node
/**
 * Observational afterShellExecution: update cache/stats without changing output.
 * Works in every Agent chat so toknt stats move even when Shell wrap does not.
 */
import { pathToFileURL } from 'node:url';

const adaptersEntry = ${JSON.stringify(adaptersEntry)};
const { OptimizingAdapterWrapper } = await import(pathToFileURL(adaptersEntry).href);
const wrapper = new OptimizingAdapterWrapper();

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);
  const event = JSON.parse(raw);
  const content = typeof event.output === 'string' ? event.output : '';
  if (!content || content.length < 500) process.exit(0);
  if (content.includes('Full output stored locally.') || content.includes('[UNCHANGED FILE]')) {
    process.exit(0);
  }
  await wrapper.processToolOutput({ toolName: 'Shell', content });
} catch (err) {
  process.stderr.write('[toknt] afterShell hook error: ' + (err?.message ?? err) + '\\n');
}
process.exit(0);
`;
}

export { CursorAdapter as default };
