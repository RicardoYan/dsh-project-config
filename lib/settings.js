// Read and validate <workspace>/.dsh/settings.yml. Every entry is validated on
// its own: a bad entry is skipped with a warning and never blocks the others.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TEXT } from './text.js';

export const SETTINGS_REL = path.join('.dsh', 'settings.yml');
export const HOOK_EVENTS = Object.freeze([
  'tools/pre-execute', 'tools/post-execute', 'agent/pre-step', 'agent/turn-stopping',
  'agent/created', 'agent/disposed', 'subagent/start', 'subagent/end',
]);

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const TOP_KEYS = new Set(['subagents', 'commands', 'mcp', 'hooks']);
const SUBAGENT_KEYS = new Set(['toolName', 'personaFile', 'description', 'provider', 'backgroundMode', 'toolFilter', 'maxDepth']);
const COMMAND_KEYS = new Set(['name', 'description', 'handlerFile', 'input']);
const MCP_COMMON = ['serverName', 'transport', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect'];
const MCP_STDIO_KEYS = new Set([...MCP_COMMON, 'command', 'args', 'env', 'cwd']);
const MCP_HTTP_KEYS = new Set([...MCP_COMMON, 'url', 'headers']);
const HOOK_KEYS = new Set(['matcher', 'command', 'timeout']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStrDict = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

function unknownKeys(obj, allowed, where, warnings) {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) warnings.push(TEXT.unknownField(where, key));
}
// Field names stay as written (they are config keys); the sentence is translated.
const skip = (where, zh, en) => TEXT.skipped(where, zh, en);

function validFilter(f) {
  if (f === undefined) return true;
  if (!isObj(f) || (f.allow === undefined && f.deny === undefined)) return false;
  return (f.allow === undefined || isStrList(f.allow)) && (f.deny === undefined || isStrList(f.deny));
}

function parseSubagents(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnings.push(TEXT.notList('subagents')); return []; }
  const out = [];
  const seen = new Set();
  raw.forEach((e, i) => {
    const where = `subagents[${i}]`;
    if (!isObj(e)) return warnings.push(TEXT.notMappingEntry(where));
    unknownKeys(e, SUBAGENT_KEYS, where, warnings);
    if (!isStr(e.toolName) || !TOOL_NAME.test(e.toolName)) return warnings.push(skip(where, `toolName 必须符合 ${TOOL_NAME}`, `toolName must match ${TOOL_NAME}`));
    if (seen.has(e.toolName)) return warnings.push(skip(where, `toolName "${e.toolName}" 重复`, `duplicate toolName "${e.toolName}"`));
    const w = `${where} (${e.toolName})`;
    if (!isStr(e.personaFile)) return warnings.push(skip(w, '缺少 personaFile', 'personaFile is required'));
    if (e.description !== undefined && typeof e.description !== 'string') return warnings.push(skip(w, 'description 必须是文字', 'description must be text'));
    if (e.provider !== undefined && !isStr(e.provider)) return warnings.push(skip(w, 'provider 必须是文字', 'provider must be text'));
    if (e.backgroundMode !== undefined && !['one-shot', 'continuable'].includes(e.backgroundMode)) return warnings.push(skip(w, 'backgroundMode 只能是 one-shot 或 continuable', 'backgroundMode must be one-shot or continuable'));
    if (!validFilter(e.toolFilter)) return warnings.push(skip(w, 'toolFilter 需要 allow 和/或 deny 列表', 'toolFilter needs allow and/or deny lists'));
    if (e.maxDepth !== undefined && !(Number.isSafeInteger(e.maxDepth) && e.maxDepth >= 0)) return warnings.push(skip(w, 'maxDepth 必须是非负整数', 'maxDepth must be a non-negative integer'));
    seen.add(e.toolName);
    out.push({
      toolName: e.toolName,
      personaFile: e.personaFile,
      description: e.description,
      provider: e.provider ?? 'spawn',
      backgroundMode: e.backgroundMode ?? 'continuable',
      toolFilter: e.toolFilter,
      maxDepth: e.maxDepth ?? 1,
    });
  });
  return out;
}

function parseCommands(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnings.push(TEXT.notList('commands')); return []; }
  const out = [];
  const seen = new Set();
  raw.forEach((e, i) => {
    const where = `commands[${i}]`;
    if (!isObj(e)) return warnings.push(TEXT.notMappingEntry(where));
    unknownKeys(e, COMMAND_KEYS, where, warnings);
    if (!isStr(e.name) || !COMMAND_NAME.test(e.name)) return warnings.push(skip(where, `name 必须符合 ${COMMAND_NAME}`, `name must match ${COMMAND_NAME}`));
    if (seen.has(e.name)) return warnings.push(skip(where, `name "${e.name}" 重复`, `duplicate name "${e.name}"`));
    const w = `${where} (${e.name})`;
    if (!isStr(e.description)) return warnings.push(skip(w, '缺少 description', 'description is required'));
    if (!isStr(e.handlerFile)) return warnings.push(skip(w, '缺少 handlerFile', 'handlerFile is required'));
    if (e.input !== undefined && !(isObj(e.input) && isStr(e.input.hint) && (e.input.attachments === undefined || typeof e.input.attachments === 'boolean'))) {
      return warnings.push(skip(w, 'input 需要非空的 hint', 'input needs a non-empty hint'));
    }
    seen.add(e.name);
    out.push({ name: e.name, description: e.description, handlerFile: e.handlerFile, input: e.input });
  });
  return out;
}

function parseMcp(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnings.push(TEXT.notList('mcp')); return []; }
  const out = [];
  const seen = new Set();
  raw.forEach((e, i) => {
    const where = `mcp[${i}]`;
    if (!isObj(e)) return warnings.push(TEXT.notMappingEntry(where));
    if (!isStr(e.serverName) || !SERVER_NAME.test(e.serverName)) return warnings.push(skip(where, `serverName 必须符合 ${SERVER_NAME}`, `serverName must match ${SERVER_NAME}`));
    const w = `${where} (${e.serverName})`;
    if (seen.has(e.serverName)) return warnings.push(skip(w, 'serverName 重复', 'duplicate serverName'));
    if (e.transport === 'stdio') {
      unknownKeys(e, MCP_STDIO_KEYS, w, warnings);
      if (!isStr(e.command)) return warnings.push(skip(w, 'stdio 需要 command', 'command is required for stdio'));
      if (e.args !== undefined && !isStrList(e.args)) return warnings.push(skip(w, 'args 必须是文字列表', 'args must be a list of text'));
      if (e.env !== undefined && !isStrDict(e.env)) return warnings.push(skip(w, 'env 的值必须是文字', 'env must map names to text'));
      if (e.cwd !== undefined && !isStr(e.cwd)) return warnings.push(skip(w, 'cwd 必须是文字', 'cwd must be text'));
    } else if (e.transport === 'streamable-http') {
      unknownKeys(e, MCP_HTTP_KEYS, w, warnings);
      if (!isStr(e.url)) return warnings.push(skip(w, 'streamable-http 需要 url', 'url is required for streamable-http'));
      if (e.headers !== undefined && !isStrDict(e.headers)) return warnings.push(skip(w, 'headers 的值必须是文字', 'headers must map names to text'));
    } else {
      return warnings.push(skip(w, 'transport 只能是 stdio 或 streamable-http', 'transport must be stdio or streamable-http'));
    }
    if (e.toolCallTimeoutMs !== undefined && !isPosInt(e.toolCallTimeoutMs)) return warnings.push(skip(w, 'toolCallTimeoutMs 必须是正整数', 'toolCallTimeoutMs must be a positive integer'));
    if (e.maxInstructionBytes !== undefined && !isPosInt(e.maxInstructionBytes)) return warnings.push(skip(w, 'maxInstructionBytes 必须是正整数', 'maxInstructionBytes must be a positive integer'));
    if (e.failOnStartupError !== undefined && typeof e.failOnStartupError !== 'boolean') return warnings.push(skip(w, 'failOnStartupError 只能是 true 或 false', 'failOnStartupError must be true or false'));
    if (e.reconnect !== undefined && !isObj(e.reconnect)) return warnings.push(skip(w, 'reconnect 必须是映射', 'reconnect must be a mapping'));
    seen.add(e.serverName);
    const entry = {};
    for (const key of e.transport === 'stdio' ? MCP_STDIO_KEYS : MCP_HTTP_KEYS) if (e[key] !== undefined) entry[key] = e[key];
    out.push(entry);
  });
  return out;
}

function parseHooks(raw, warnings) {
  const out = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) { warnings.push(TEXT.hooksNotMapping); return out; }
  for (const [event, list] of Object.entries(raw)) {
    if (!HOOK_EVENTS.includes(event)) { warnings.push(TEXT.unknownEvent(event, HOOK_EVENTS.join(', '))); continue; }
    if (!Array.isArray(list)) { warnings.push(TEXT.notList(`hooks.${event}`)); continue; }
    const entries = [];
    list.forEach((h, i) => {
      const where = `hooks.${event}[${i}]`;
      if (!isObj(h)) return warnings.push(TEXT.notMappingEntry(where));
      unknownKeys(h, HOOK_KEYS, where, warnings);
      if (!isStr(h.command)) return warnings.push(skip(where, '缺少 command', 'command is required'));
      if (h.matcher !== undefined && typeof h.matcher !== 'string') return warnings.push(skip(where, 'matcher 必须是文字', 'matcher must be text'));
      if (h.timeout !== undefined && !(typeof h.timeout === 'number' && h.timeout > 0)) return warnings.push(skip(where, 'timeout 必须是正数（秒）', 'timeout must be a positive number of seconds'));
      entries.push({ matcher: h.matcher, command: h.command, timeout: h.timeout });
    });
    if (entries.length > 0) out[event] = entries;
  }
  return out;
}

/** Parse YAML text into normalized settings plus warnings. */
export function parseSettings(text) {
  const warnings = [];
  let raw;
  try { raw = parseYaml(text); } catch (error) {
    return { ok: false, error: TEXT.yamlError(error?.message ?? error), warnings };
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isObj(raw)) return { ok: false, error: TEXT.notMapping, warnings };
  for (const key of Object.keys(raw)) {
    if (key === 'skills') warnings.push(TEXT.skillsRemoved);
    else if (!TOP_KEYS.has(key)) warnings.push(TEXT.unknownTop(key));
  }
  return {
    ok: true,
    warnings,
    settings: {
      subagents: parseSubagents(raw.subagents, warnings),
      commands: parseCommands(raw.commands, warnings),
      mcp: parseMcp(raw.mcp, warnings),
      hooks: parseHooks(raw.hooks, warnings),
    },
  };
}

/** Load settings for a workspace root; `undefined` when the file does not exist. */
export async function loadSettings(root) {
  const file = path.join(root, SETTINGS_REL);
  let text;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return undefined;
    if (st.size > 1024 * 1024) return { file, ok: false, error: TEXT.tooBig, warnings: [] };
    text = await fs.promises.readFile(file, 'utf8');
  } catch { return undefined; }
  return { file, ...parseSettings(text) };
}

/** Expand ${VAR} from `env`; returns { value } or { missing: [names] }. */
export function expandVars(value, env = process.env) {
  const missing = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env[name];
    if (v === undefined) { missing.push(name); return ''; }
    return v;
  });
  return missing.length ? { missing } : { value: out };
}

/** Strip a leading YAML frontmatter block; returns { body, description }. */
export function splitPersona(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text.trim(), description: undefined };
  let description;
  try {
    const fm = parseYaml(m[1]);
    if (isObj(fm) && typeof fm.description === 'string') description = fm.description.trim();
  } catch { /* malformed frontmatter: still strip it */ }
  return { body: text.slice(m[0].length).trim(), description };
}
