import { access, cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BaseAdapter, type AgentInfo, type ToolOutput, OptimizingAdapterWrapper } from '@toknt/adapters';

const HERE = dirname(fileURLToPath(import.meta.url));

const TOKNT_MARKER = '.cursor/toknt/hooks/';

function resolveAdaptersEntry(): string {
  try {
    return fileURLToPath(import.meta.resolve('@toknt/adapters'));
  } catch {
    const fallback = join(HERE, '../../../packages/adapters/dist/index.js');
    return fallback;
  }
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
    const hookDir = join(cursorDir, 'toknt');
    const hooksDir = join(hookDir, 'hooks');
    await mkdir(hooksDir, { recursive: true });

    const adaptersEntry = resolveAdaptersEntry();
    const nodeBin = process.execPath;

    const postHookPath = join(hooksDir, 'post-tool-use.mjs');
    const preHookPath = join(hooksDir, 'pre-tool-use.mjs');
    const shellWrapPath = join(hooksDir, 'shell-wrap.mjs');

    await writeFile(postHookPath, buildPostToolUseHook(adaptersEntry), { mode: 0o755 });
    await writeFile(preHookPath, buildPreToolUseHook(shellWrapPath), { mode: 0o755 });
    await writeFile(shellWrapPath, buildShellWrapHook(adaptersEntry), { mode: 0o755 });
    await chmod(postHookPath, 0o755);
    await chmod(preHookPath, 0o755);
    await chmod(shellWrapPath, 0o755);

    const config = {
      version: '1.0.0',
      provider: 'toknt',
      hooks: {
        postToolUse: './hooks/post-tool-use.mjs',
        preToolUse: './hooks/pre-tool-use.mjs',
      },
      adaptersEntry,
    };
    await writeFile(join(hookDir, 'toknt.json'), JSON.stringify(config, null, 2));

    await mergeCursorHooksJson(cursorDir, {
      postToolUse: `${nodeBin} ${shellQuote(postHookPath)}`,
      preToolUse: `${nodeBin} ${shellQuote(preHookPath)}`,
    });

    await installCursorPlugin(cursorDir);
  }

  async uninstall(): Promise<void> {
    const cursorDir = join(homedir(), '.cursor');
    await removeTokntHooks(cursorDir);
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

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

async function mergeCursorHooksJson(
  cursorDir: string,
  commands: { postToolUse: string; preToolUse: string }
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
    hooks.filter((h) => !h.command.includes(TOKNT_MARKER));

  config.hooks.postToolUse = [
    ...stripToknt(config.hooks.postToolUse),
    { command: commands.postToolUse },
  ];
  config.hooks.preToolUse = [
    ...stripToknt(config.hooks.preToolUse),
    { command: commands.preToolUse, matcher: 'Shell' },
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
      config.hooks[key] = (config.hooks[key] ?? []).filter((h) => !h.command.includes(TOKNT_MARKER));
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
 * Tokn't Cursor postToolUse hook (stdin JSON → stdout JSON).
 * Caches/stats optimizations quietly. Only rewrites model-visible output for MCP
 * (updated_mcp_tool_output). Never injects additional_context — that stacks on
 * top of the real tool result and adds tokens instead of saving them.
 * Shell savings come from the preToolUse shell-wrap path.
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

  // Already compressed by shell-wrap — don't reprocess or spam context.
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

  // Cursor only allows replacing MCP tool payloads. For everything else, stay silent.
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
 * Tokn't Cursor preToolUse hook — wrap Shell commands so stdout is compressed.
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

function shouldSkip(command) {
  if (!command || typeof command !== 'string') return true;
  if (command.includes('toknt/hooks/shell-wrap')) return true;
  const interactive =
    /\\b(vim|nvim|nano|less|more|top|htop|ssh|scp|sftp|ftp|mysql|psql|redis-cli|python -i|node -i|gdb|lldb)\\b/i;
  return interactive.test(command);
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

  if (!isShell || mode === 'safe' || shouldSkip(command)) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\\n');
    process.exit(0);
  }

  const wrapped =
    nodeBin +
    ' ' +
    JSON.stringify(shellWrapPath) +
    ' -- ' +
    command;

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
 * Runs a shell command and prints Tokn't-optimized stdout/stderr.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const adaptersEntry = ${JSON.stringify(adaptersEntry)};
const { OptimizingAdapterWrapper } = await import(pathToFileURL(adaptersEntry).href);
const wrapper = new OptimizingAdapterWrapper();

const sep = process.argv.indexOf('--');
const command = sep >= 0 ? process.argv.slice(sep + 1).join(' ') : process.argv.slice(2).join(' ');

if (!command) {
  process.stderr.write('[toknt] shell-wrap: missing command\\n');
  process.exit(1);
}

const child = spawn(command, {
  shell: true,
  env: process.env,
  cwd: process.cwd(),
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => {
  stdout += d.toString();
});
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const code = await new Promise((resolve) => {
  child.on('close', (c) => resolve(c ?? 0));
  child.on('error', () => resolve(1));
});

const combined = stderr ? stdout + (stdout ? '\\n' : '') + stderr : stdout;

try {
  const optimized = await wrapper.processToolOutput({
    toolName: 'Shell',
    content: combined,
  });
  process.stdout.write(optimized.content);
  if (!optimized.content.endsWith('\\n')) process.stdout.write('\\n');
} catch {
  process.stdout.write(combined);
}

process.exit(code);
`;
}

export { CursorAdapter as default };
