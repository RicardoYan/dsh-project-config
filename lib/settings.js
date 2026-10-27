// Parse and validate one settings file (`.dsh/settings.yml` or
// `.dsh/settings.local.yml`). Every entry is validated on its own: a bad entry
// is skipped with a warning and never blocks the others. Merging the two files
// lives in project-settings.ts.
//
// Messages never quote values from the file (YAML errors report only a
// position): settings.local.yml is where credentials are written in plain text.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TEXT } from './text.js';
export const SETTINGS_NAME = 'settings.yml';
export const LOCAL_NAME = 'settings.local.yml';
export const SETTINGS_REL = path.join('.dsh', SETTINGS_NAME);
export const LOCAL_REL = path.join('.dsh', LOCAL_NAME);
export const MAX_SETTINGS_BYTES = 1024 * 1024;
export const HOOK_EVENTS = Object.freeze([
    'tools/pre-execute',
    'tools/post-execute',
    'agent/pre-step',
    'agent/turn-stopping',
    'agent/created',
    'agent/disposed',
    'subagent/start',
    'subagent/end',
]);
const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const TOP_KEYS = new Set(['subagents', 'commands', 'mcp', 'hooks']);
const SUBAGENT_KEYS = new Set([
    'toolName',
    'personaFile',
    'description',
    'provider',
    'toolFilter',
    'maxDepth',
    'agentOptions',
]);
const AGENT_OPTION_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'maxTokens']);
const COMMAND_KEYS = new Set(['name', 'description', 'handlerFile', 'input']);
const MCP_COMMON = [
    'serverName',
    'transport',
    'toolCallTimeoutMs',
    'failOnStartupError',
    'maxInstructionBytes',
    'reconnect',
];
const MCP_STDIO_KEYS = new Set([...MCP_COMMON, 'command', 'args', 'env', 'cwd']);
const MCP_HTTP_KEYS = new Set([...MCP_COMMON, 'url', 'headers']);
const HOOK_KEYS = new Set(['matcher', 'command', 'timeout']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStrDict = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
// On named list entries `enabled` is handled by enabledOf, not reported here.
function unknownKeys(obj, allowed, where, warnings, named = true) {
    for (const key of Object.keys(obj)) {
        if (!(named && key === 'enabled') && !allowed.has(key))
            warnings.push(TEXT.unknownField(where, key));
    }
}
// Field names stay as written (they are config keys); the sentence is translated.
const skip = (where, zh, en) => TEXT.skipped(where, zh, en);
/**
 * `enabled` on a list entry. Only settings.local.yml honours it: `false`
 * removes the settings.yml entry of the same name. In settings.yml it is
 * reported and ignored, and the entry loads as usual.
 */
function enabledOf(e, where, p) {
    if (e['enabled'] === undefined)
        return 'keep';
    if (!p.local) {
        p.warnings.push(TEXT.enabledShared(where));
        return 'keep';
    }
    if (typeof e['enabled'] !== 'boolean') {
        p.warnings.push(skip(where, 'enabled 只能是 true 或 false', 'enabled must be true or false'));
        return 'skip';
    }
    return e['enabled'] ? 'keep' : 'remove';
}
function validFilter(f) {
    if (f === undefined)
        return true;
    if (!isObj(f) || (f['allow'] === undefined && f['deny'] === undefined))
        return false;
    return ((f['allow'] === undefined || isStrList(f['allow'])) && (f['deny'] === undefined || isStrList(f['deny'])));
}
/**
 * Why an `agentOptions` value is unusable, or undefined when it is fine.
 *
 * Three checks the runtime does NOT make for a project subagent:
 * - the object must be a plain mapping with no unknown key (DSH's schema is
 *   `z.object` without `.strict`, so an unknown key would silently ride along);
 * - `provider` and `model` form one route and must be supplied together. DSH's
 *   own pairing error lives in `requestedAgentOptions()`, but that function
 *   returns early unless the model passed `provider`/`model` at call time —
 *   a project subagent never does, so the check would never fire here. Half a
 *   route would then inherit the parent's other half and resolve to a route
 *   that may not exist (`pi-ai provider "x" has no configured model "y"`);
 * - an empty object is a no-op that still travels to the tool config.
 */
function agentOptionsProblem(v) {
    if (!isObj(v))
        return { zh: 'agentOptions 必须是对象', en: 'agentOptions must be an object' };
    const unknown = Object.keys(v).filter((k) => !AGENT_OPTION_KEYS.has(k));
    if (unknown.length > 0) {
        return {
            zh: `agentOptions 含未知字段 ${unknown.join(', ')}`,
            en: `agentOptions has unknown fields ${unknown.join(', ')}`,
        };
    }
    if (Object.keys(v).length === 0) {
        return { zh: 'agentOptions 不能为空', en: 'agentOptions must not be empty' };
    }
    for (const k of ['provider', 'model', 'reasoningEffort']) {
        if (v[k] !== undefined && !isStr(v[k])) {
            return { zh: `agentOptions.${k} 必须是文字`, en: `agentOptions.${k} must be text` };
        }
    }
    const mt = v['maxTokens'];
    if (mt !== undefined && !isPosInt(mt)) {
        return {
            zh: 'agentOptions.maxTokens 必须是正整数',
            en: 'agentOptions.maxTokens must be a positive integer',
        };
    }
    if ((v['provider'] === undefined) !== (v['model'] === undefined)) {
        return {
            zh: 'agentOptions 的 provider 与 model 必须同时给出',
            en: 'agentOptions needs provider and model together',
        };
    }
    return undefined;
}
function parseSubagents(raw, p) {
    const { warnings } = p;
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw)) {
        warnings.push(TEXT.notList('subagents'));
        return [];
    }
    const out = [];
    const seen = new Set();
    raw.forEach((e, i) => {
        const where = `subagents[${i}]`;
        if (!isObj(e))
            return void warnings.push(TEXT.notMappingEntry(where));
        const toolName = e['toolName'];
        if (!isStr(toolName) || !TOOL_NAME.test(toolName)) {
            return void warnings.push(skip(where, `toolName 必须符合 ${TOOL_NAME}`, `toolName must match ${TOOL_NAME}`));
        }
        if (seen.has(toolName)) {
            return void warnings.push(skip(where, `toolName "${toolName}" 重复`, `duplicate toolName "${toolName}"`));
        }
        const w = `${where} (${toolName})`;
        const state = enabledOf(e, w, p);
        if (state === 'skip')
            return;
        if (state === 'remove') {
            seen.add(toolName);
            return void p.removals.push({ kind: 'subagents', name: toolName, where: w });
        }
        unknownKeys(e, SUBAGENT_KEYS, w, warnings);
        const personaFile = e['personaFile'];
        if (!isStr(personaFile))
            return void warnings.push(skip(w, '缺少 personaFile', 'personaFile is required'));
        if (e['description'] !== undefined && typeof e['description'] !== 'string') {
            return void warnings.push(skip(w, 'description 必须是文字', 'description must be text'));
        }
        if (e['provider'] !== undefined && !isStr(e['provider'])) {
            return void warnings.push(skip(w, 'provider 必须是文字', 'provider must be text'));
        }
        if (!validFilter(e['toolFilter'])) {
            return void warnings.push(skip(w, 'toolFilter 需要 allow 和/或 deny 列表', 'toolFilter needs allow and/or deny lists'));
        }
        if (e['maxDepth'] !== undefined && !(Number.isSafeInteger(e['maxDepth']) && e['maxDepth'] >= 0)) {
            return void warnings.push(skip(w, 'maxDepth 必须是非负整数', 'maxDepth must be a non-negative integer'));
        }
        const agentOptions = e['agentOptions'];
        if (agentOptions !== undefined) {
            const bad = agentOptionsProblem(agentOptions);
            if (bad !== undefined)
                return void warnings.push(skip(w, bad.zh, bad.en));
        }
        seen.add(toolName);
        out.push({
            toolName,
            personaFile,
            description: e['description'],
            provider: e['provider'] ?? 'spawn',
            toolFilter: e['toolFilter'],
            maxDepth: e['maxDepth'] ?? 1,
            agentOptions: agentOptions,
        });
    });
    return out;
}
function parseCommands(raw, p) {
    const { warnings } = p;
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw)) {
        warnings.push(TEXT.notList('commands'));
        return [];
    }
    const out = [];
    const seen = new Set();
    raw.forEach((e, i) => {
        const where = `commands[${i}]`;
        if (!isObj(e))
            return void warnings.push(TEXT.notMappingEntry(where));
        const name = e['name'];
        if (!isStr(name) || !COMMAND_NAME.test(name)) {
            return void warnings.push(skip(where, `name 必须符合 ${COMMAND_NAME}`, `name must match ${COMMAND_NAME}`));
        }
        if (seen.has(name)) {
            return void warnings.push(skip(where, `name "${name}" 重复`, `duplicate name "${name}"`));
        }
        const w = `${where} (${name})`;
        const state = enabledOf(e, w, p);
        if (state === 'skip')
            return;
        if (state === 'remove') {
            seen.add(name);
            return void p.removals.push({ kind: 'commands', name, where: w });
        }
        unknownKeys(e, COMMAND_KEYS, w, warnings);
        const description = e['description'];
        const handlerFile = e['handlerFile'];
        if (!isStr(description))
            return void warnings.push(skip(w, '缺少 description', 'description is required'));
        if (!isStr(handlerFile))
            return void warnings.push(skip(w, '缺少 handlerFile', 'handlerFile is required'));
        const input = e['input'];
        if (input !== undefined &&
            !(isObj(input) &&
                isStr(input['hint']) &&
                (input['attachments'] === undefined || typeof input['attachments'] === 'boolean'))) {
            return void warnings.push(skip(w, 'input 需要非空的 hint', 'input needs a non-empty hint'));
        }
        seen.add(name);
        out.push({ name, description, handlerFile, input: input });
    });
    return out;
}
function parseMcp(raw, p) {
    const { warnings } = p;
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw)) {
        warnings.push(TEXT.notList('mcp'));
        return [];
    }
    const out = [];
    const seen = new Set();
    raw.forEach((e, i) => {
        const where = `mcp[${i}]`;
        if (!isObj(e))
            return void warnings.push(TEXT.notMappingEntry(where));
        const serverName = e['serverName'];
        if (!isStr(serverName) || !SERVER_NAME.test(serverName)) {
            return void warnings.push(skip(where, `serverName 必须符合 ${SERVER_NAME}`, `serverName must match ${SERVER_NAME}`));
        }
        const w = `${where} (${serverName})`;
        if (seen.has(serverName)) {
            return void warnings.push(skip(w, 'serverName 重复', 'duplicate serverName'));
        }
        const state = enabledOf(e, w, p);
        if (state === 'skip')
            return;
        if (state === 'remove') {
            seen.add(serverName);
            return void p.removals.push({ kind: 'mcp', name: serverName, where: w });
        }
        if (e['transport'] === 'stdio') {
            unknownKeys(e, MCP_STDIO_KEYS, w, warnings);
            if (!isStr(e['command'])) {
                return void warnings.push(skip(w, 'stdio 需要 command', 'command is required for stdio'));
            }
            if (e['args'] !== undefined && !isStrList(e['args'])) {
                return void warnings.push(skip(w, 'args 必须是文字列表', 'args must be a list of text'));
            }
            if (e['env'] !== undefined && !isStrDict(e['env'])) {
                return void warnings.push(skip(w, 'env 的值必须是文字', 'env must map names to text'));
            }
            if (e['cwd'] !== undefined && !isStr(e['cwd'])) {
                return void warnings.push(skip(w, 'cwd 必须是文字', 'cwd must be text'));
            }
        }
        else if (e['transport'] === 'streamable-http') {
            unknownKeys(e, MCP_HTTP_KEYS, w, warnings);
            if (!isStr(e['url'])) {
                return void warnings.push(skip(w, 'streamable-http 需要 url', 'url is required for streamable-http'));
            }
            if (e['headers'] !== undefined && !isStrDict(e['headers'])) {
                return void warnings.push(skip(w, 'headers 的值必须是文字', 'headers must map names to text'));
            }
        }
        else {
            return void warnings.push(skip(w, 'transport 只能是 stdio 或 streamable-http', 'transport must be stdio or streamable-http'));
        }
        if (e['toolCallTimeoutMs'] !== undefined && !isPosInt(e['toolCallTimeoutMs'])) {
            return void warnings.push(skip(w, 'toolCallTimeoutMs 必须是正整数', 'toolCallTimeoutMs must be a positive integer'));
        }
        if (e['maxInstructionBytes'] !== undefined && !isPosInt(e['maxInstructionBytes'])) {
            return void warnings.push(skip(w, 'maxInstructionBytes 必须是正整数', 'maxInstructionBytes must be a positive integer'));
        }
        if (e['failOnStartupError'] !== undefined && typeof e['failOnStartupError'] !== 'boolean') {
            return void warnings.push(skip(w, 'failOnStartupError 只能是 true 或 false', 'failOnStartupError must be true or false'));
        }
        if (e['reconnect'] !== undefined && !isObj(e['reconnect'])) {
            return void warnings.push(skip(w, 'reconnect 必须是映射', 'reconnect must be a mapping'));
        }
        seen.add(serverName);
        const entry = {};
        for (const key of e['transport'] === 'stdio' ? MCP_STDIO_KEYS : MCP_HTTP_KEYS) {
            if (e[key] !== undefined)
                entry[key] = e[key];
        }
        out.push(entry);
    });
    return out;
}
function parseHooks(raw, { warnings }) {
    const out = {};
    if (raw === undefined)
        return out;
    if (!isObj(raw)) {
        warnings.push(TEXT.hooksNotMapping);
        return out;
    }
    for (const [event, list] of Object.entries(raw)) {
        if (!HOOK_EVENTS.includes(event)) {
            warnings.push(TEXT.unknownEvent(event, HOOK_EVENTS.join(', ')));
            continue;
        }
        if (!Array.isArray(list)) {
            warnings.push(TEXT.notList(`hooks.${event}`));
            continue;
        }
        const entries = [];
        list.forEach((h, i) => {
            const where = `hooks.${event}[${i}]`;
            if (!isObj(h))
                return void warnings.push(TEXT.notMappingEntry(where));
            unknownKeys(h, HOOK_KEYS, where, warnings, false);
            if (!isStr(h['command']))
                return void warnings.push(skip(where, '缺少 command', 'command is required'));
            if (h['matcher'] !== undefined && typeof h['matcher'] !== 'string') {
                return void warnings.push(skip(where, 'matcher 必须是文字', 'matcher must be text'));
            }
            if (h['timeout'] !== undefined && !(typeof h['timeout'] === 'number' && h['timeout'] > 0)) {
                return void warnings.push(skip(where, 'timeout 必须是正数（秒）', 'timeout must be a positive number of seconds'));
            }
            entries.push({
                matcher: h['matcher'],
                command: h['command'],
                timeout: h['timeout'],
            });
        });
        if (entries.length > 0)
            out[event] = entries;
    }
    return out;
}
/** 1-based line and column of a character offset. */
function position(text, offset) {
    const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
    const line = before.split('\n').length;
    return { line, col: offset - before.lastIndexOf('\n') };
}
/**
 * Parse YAML text into normalized settings plus warnings.
 * @param opts.local - parsing settings.local.yml: `enabled: false` entries are
 *   returned in `removals` ([{ kind, name, where }]) instead of `settings`.
 */
export function parseSettings(text, { local = false } = {}) {
    const warnings = [];
    const p = { warnings, local, removals: [] };
    let raw;
    // prettyErrors:false keeps the source line (which may hold a token) out of
    // the message; logLevel:'error' stops yaml printing warnings to stderr.
    try {
        raw = parseYaml(text, { prettyErrors: false, logLevel: 'error' });
    }
    catch (error) {
        const pos = error?.pos;
        const at = Array.isArray(pos) ? position(text, pos[0]) : undefined;
        return { ok: false, error: TEXT.yamlError(at), warnings };
    }
    if (raw === null || raw === undefined)
        raw = {};
    if (!isObj(raw))
        return { ok: false, error: TEXT.notMapping, warnings };
    for (const key of Object.keys(raw)) {
        if (key === 'skills')
            warnings.push(TEXT.skillsRemoved);
        else if (!TOP_KEYS.has(key))
            warnings.push(TEXT.unknownTop(key));
    }
    return {
        ok: true,
        warnings,
        settings: {
            subagents: parseSubagents(raw['subagents'], p),
            commands: parseCommands(raw['commands'], p),
            mcp: parseMcp(raw['mcp'], p),
            hooks: parseHooks(raw['hooks'], p),
        },
        removals: p.removals,
    };
}
/**
 * Read and parse one settings file; `undefined` when it does not exist (or is
 * not a regular file). Errors are unprefixed; the caller adds the file name.
 */
export async function readSettingsFile(file, opts) {
    let text;
    try {
        const st = await fs.promises.stat(file);
        if (!st.isFile())
            return undefined;
        if (st.size > MAX_SETTINGS_BYTES)
            return { file, ok: false, error: TEXT.tooBig, warnings: [] };
    }
    catch {
        return undefined;
    }
    try {
        text = await fs.promises.readFile(file, 'utf8');
    }
    catch {
        return { file, ok: false, error: TEXT.readFailed, warnings: [] };
    }
    return { file, ...parseSettings(text, opts) };
}
/** Expand ${VAR} from `env`; returns { value } or { missing: [names] }. */
export function expandVars(value, env = process.env) {
    const missing = [];
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
        const v = env[name];
        if (v === undefined) {
            missing.push(name);
            return '';
        }
        return v;
    });
    return missing.length > 0 ? { missing } : { value: out };
}
/** Strip a leading YAML frontmatter block; returns { body, description }. */
export function splitPersona(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (m === null)
        return { body: text.trim(), description: undefined };
    let description;
    try {
        const fm = parseYaml(m[1]);
        if (isObj(fm) && typeof fm['description'] === 'string')
            description = fm['description'].trim();
    }
    catch {
        /* malformed frontmatter: still strip it */
    }
    return { body: text.slice(m[0].length).trim(), description };
}
