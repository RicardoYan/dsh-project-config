// Self-test for dsh-project-config. Run with DSH's bundled node:
//   node test/selftest.mjs
// Official packages are resolved from DSH_PACKAGES (default: the DSH install's
// extracted node_modules), so the repository needs no node_modules of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// The plugin log goes to the temp dir: keep test runs out of the real one.
const testTemp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pcfg-temp-')));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = testTemp;

const PACKAGES = process.env.DSH_PACKAGES;
if (!PACKAGES || !fs.existsSync(PACKAGES)) {
  console.log('set DSH_PACKAGES to the directory holding @deepseek-ai/* and yaml (DSH install node_modules)');
  process.exit(2);
}
const anchor = pathToFileURL(path.join(PACKAGES, '__anchor__.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (/^[@a-z]/i.test(specifier) && !specifier.startsWith('node:')) return next(specifier, { ...context, parentURL: anchor });
      throw error;
    }
  },
});

const { parseSettings, expandVars, splitPersona } = await import('../lib/settings.js');
const { loadProjectSettings: loadSettings, mergeSettings } = await import('../lib/project-settings.js');
const { builtinFindRoot, builtinCheckTarget, createWorkspace } = await import('../lib/workspace.js');
const { admits, officialFilter, interceptTools, rosterText } = await import('../lib/features/subagents.js');
const { McpHub, resolveServerConfig } = await import('../lib/features/mcp.js');
const { mountHooks, validateHookMatchers, forwardExitCode } = await import('../lib/features/hooks.js');
const { normalizeResult, loadHandler } = await import('../lib/features/commands.js');
const { rewriteRoots, patchSkillRoots, installInstructionsMarker, MARKER } = await import('../lib/isolation.js');
const { statusText, reconnectText } = await import('../lib/status.js');
const { createLog } = await import('../lib/log.js');
const { setLocaleSource, lang } = await import('../lib/locale.js');
const { TEXT } = await import('../lib/text.js');
let uiLang = 'zh';
setLocaleSource(() => uiLang);
const inLang = (l, fn) => { const prev = uiLang; uiLang = l; try { return fn(); } finally { uiLang = prev; } };
const CJK = /[\u4e00-\u9fff]/;
const { FileSystemSkillProvider } = await import('@deepseek-ai/dsh-skill-filesystem');
const { apply: instructionsApply } = await import('@deepseek-ai/dsh-agent-instructions');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const truthy = (label, v) => check(label, !!v, true);
const quietLog = { info() {}, warn() {}, error() {} };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/** Fake SDK client + transport driven by the test (fields set on the returned object). */
function fakeMcp() {
  const f = { tools: [], connectError: undefined, callError: undefined, callResult: { content: [] }, pingError: undefined, stderrText: '', current: undefined };
  f.transportFactory = (config) => {
    const listeners = [];
    const t = { config, closed: false, close: async () => { t.closed = true; }, stderr: { on: (ev, fn) => { if (ev === 'data') listeners.push(fn); } } };
    t.emitStderr = () => { if (f.stderrText) for (const fn of listeners) fn(f.stderrText); };
    return t;
  };
  f.clientFactory = (onListChanged) => {
    const c = {
      transport: undefined, onclose: undefined, onerror: undefined,
      async connect(transport) {
        transport.emitStderr();
        const err = f.connectError?.(transport.config);
        if (err) throw err;
        c.transport = transport;
        f.current = c;
      },
      getInstructions: () => '',
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({ tools: f.tools }),
      callTool: async () => { if (f.callError) throw f.callError; return f.callResult; },
      ping: async () => { if (f.pingError) throw f.pingError; return {}; },
      async close() { if (c.transport) { c.transport = undefined; queueMicrotask(() => c.onclose?.()); } },
      listChanged: () => onListChanged(),
      closeFromServer() { c.transport = undefined; c.onclose?.(); },
    };
    return c;
  };
  return f;
}

/** Minimal agent-scope stand-in for McpHub.startIn. */
function fakeScope() {
  const scope = { sections: [], resources: [], registeredTools: new Map() };
  scope.tools = { register: (d) => { scope.registeredTools.set(d.name, d); return () => scope.registeredTools.delete(d.name); } };
  scope.inject = (deps, fn) => {
    if (deps[0] === 'mcpResources') fn({ mcpResources: { register: (name) => { scope.resources.push(name); } } });
    if (deps[0] === 'systemPrompt') fn({ systemPrompt: { section: (s) => scope.sections.push(s), getSectionOrder: () => 3000 } });
  };
  return scope;
}

/** The official client's internal name rule, loaded from its module source for comparison. */
async function officialInternals() {
  const file = path.join(PACKAGES, '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const MAX_PUBLIC_NAME_LENGTH');
  const end = src.indexOf('/**', src.indexOf('function publicToolName'));
  const body = src.slice(start, end).replace(/\/\*\*[\s\S]*?\*\//g, '');
  const fn = new Function('createHash', `${body}; return { publicToolName };`);
  return fn((await import('node:crypto')).createHash);
}

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pcfg-')));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };

// ---------------------------------------------------------------- settings
{
  const r = parseSettings(`
subagents:
  - toolName: code-reviewer
    personaFile: agents/doc.md
    toolFilter: { allow: [read] }
  - toolName: Bad Name
    personaFile: x.md
  - toolName: code-reviewer
    personaFile: y.md
  - toolName: nofile
commands:
  - name: hello
    description: say hi
    handlerFile: cmds/hello.js
    input: { hint: '<who>' }
  - name: hello
    description: dup
    handlerFile: x.js
  - name: noinput
    description: d
    handlerFile: x.js
    input: { hint: '' }
mcp:
  - serverName: local
    transport: stdio
    command: node
    args: [server.js]
    env: { TOKEN: '\${MY_TOKEN}' }
    extra: 1
  - serverName: web
    transport: streamable-http
    url: http://localhost/mcp
  - serverName: bad
    transport: ftp
hooks:
  tools/pre-execute:
    - matcher: pwsh|bash
      command: node check.js
      timeout: 5
    - command: ''
  PreToolUse:
    - command: x
skills:
  - name: old
other: 1
`);
  check('settings: ok', r.ok, true);
  check('settings: subagents kept', r.settings.subagents.map((s) => [s.toolName, s.provider, s.backgroundMode, s.maxDepth]), [['code-reviewer', 'spawn', 'continuable', 1]]);
  check('settings: commands kept', r.settings.commands.map((c) => c.name), ['hello']);
  check('settings: mcp kept', r.settings.mcp.map((m) => m.serverName), ['local', 'web']);
  check('settings: mcp unknown field dropped', 'extra' in r.settings.mcp[0], false);
  check('settings: hooks kept', Object.keys(r.settings.hooks), ['tools/pre-execute']);
  check('settings: hook entry', r.settings.hooks['tools/pre-execute'], [{ matcher: 'pwsh|bash', command: 'node check.js', timeout: 5 }]);
  const w = inLang('en', () => r.warnings.join('\n'));
  for (const needle of ['toolName must match', 'duplicate toolName', 'personaFile is required', 'duplicate name', 'non-empty hint', 'unknown field "extra"', 'transport must be', 'unknown event "PreToolUse"', 'command is required', 'skills: no longer supported', 'unknown top-level field "other"']) {
    truthy(`settings: warning ${needle}`, w.includes(needle));
  }
  const wz = inLang('zh', () => r.warnings.join('\n'));
  for (const needle of ['toolName 必须符合', 'toolName "code-reviewer" 重复', '缺少 personaFile', 'name "hello" 重复', 'input 需要非空的 hint', '未知字段 "extra"', 'transport 只能是', '未知事件 "PreToolUse"', '缺少 command', 'skills：已不再支持', '未知的顶层字段 "other"']) {
    truthy(`settings: zh warning ${needle}`, wz.includes(needle));
  }
  check('settings: en warnings have no chinese', CJK.test(w), false);
  check('settings: zh warnings have no english sentences', /\b(must|ignored|skipped|required|duplicate|unknown)\b/.test(wz), false);
  check('settings: bad yaml', parseSettings('a: [').ok, false);
  check('settings: non-mapping', parseSettings('- 1').ok, false);
  check('settings: empty file ok', parseSettings('').ok, true);
}
check('expand: ok', expandVars('a ${X} b', { X: '1' }), { value: 'a 1 b' });
check('expand: missing', expandVars('${X}${Y}', { X: '1' }), { missing: ['Y'] });
check('expand: plain $X untouched', expandVars('$X', { X: '1' }), { value: '$X' });
check('persona: frontmatter stripped', splitPersona('---\nname: a\ndescription: Does docs\n---\n\nBody here\n'), { body: 'Body here', description: 'Does docs' });
check('persona: no frontmatter', splitPersona('  just body  '), { body: 'just body', description: undefined });
check('persona: CRLF', splitPersona('---\r\ndescription: d\r\n---\r\nB'), { body: 'B', description: 'd' });

// ---------------------------------------------------------------- workspace (builtin, restricted)
const gitRoot = mk('repo'); mk('repo', '.git');
const sub = mk('repo', 'pkg'); write(path.join(sub, '.dsh', 'settings.yml'), 'subagents: []');
const deep = mk('repo', 'pkg', 'src', 'x');
const outside = mk('outside'); write(path.join(outside, 'p.md'), 'p');
write(path.join(sub, 'inside.md'), 'i');
fs.symlinkSync(outside, path.join(sub, 'link-out'), 'junction');
check('root: settings.yml nearer', await builtinFindRoot(deep), sub);
check('root: git', await builtinFindRoot(path.join(gitRoot)), gitRoot);
check('check: inside ok', (await builtinCheckTarget(sub, 'inside.md', { type: 'file' })).ok, true);
check('check: outside via junction refused', (await builtinCheckTarget(sub, 'link-out/p.md')).code, 'UNTRUSTED');
check('check: escape', (await builtinCheckTarget(sub, '../x')).code, 'BAD_PATH');
check('check: absolute', (await builtinCheckTarget(sub, outside)).code, 'BAD_PATH');
check('check: missing', (await builtinCheckTarget(sub, 'nope')).code, 'NOT_FOUND');
check('check: type', (await builtinCheckTarget(sub, 'inside.md', { type: 'directory' })).code, 'WRONG_TYPE');
{
  const noTrust = createWorkspace(() => undefined);
  check('ws: no trust -> untrusted', [noTrust.hasTrust(), noTrust.state(sub), await noTrust.ensure({}, sub)], [false, 'untrusted', 'untrusted']);
  const calls = [];
  const fake = { findRoot: async () => 'R', state: () => 'unknown', ensure: async (o) => { calls.push(o.root); return 'trusted'; }, checkTarget: async () => ({ ok: true, realPath: 'X' }) };
  const withTrust = createWorkspace(() => fake);
  check('ws: delegates', [withTrust.hasTrust(), await withTrust.findRoot('c'), withTrust.state('R'), await withTrust.ensure({}, 'R'), (await withTrust.checkTarget('R', 'a')).realPath, calls], [true, 'R', 'unknown', 'trusted', 'X', ['R']]);
}
{
  const loaded = await loadSettings(sub);
  check('load: found', [loaded.ok, loaded.file], [true, path.join(sub, '.dsh', 'settings.yml')]);
  check('load: absent', await loadSettings(gitRoot), undefined);
}

// ---------------------------------------------------------------- settings.local.yml
{
  const ws = (name, shared, local) => {
    const r = mk('local', name);
    if (shared !== undefined) write(path.join(r, '.dsh', 'settings.yml'), shared);
    if (local !== undefined) write(path.join(r, '.dsh', 'settings.local.yml'), local);
    return r;
  };
  const SHARED = `
subagents:
  - { toolName: a, personaFile: a.md }
  - { toolName: b, personaFile: b.md }
commands:
  - { name: c1, description: d, handlerFile: c1.mjs }
  - { name: c2, description: d, handlerFile: c2.mjs }
mcp:
  - { serverName: s1, transport: stdio, command: node }
  - { serverName: s2, transport: stdio, command: node }
  - { serverName: s3, transport: stdio, command: node }
hooks:
  tools/pre-execute:
    - { command: shared-1 }
    - { command: shared-2 }
  agent/pre-step:
    - { command: shared-step }
`;
  const LOCAL = `
subagents:
  - { toolName: a, personaFile: a-local.md }
  - { toolName: z, personaFile: z.md }
commands:
  - { name: c1, description: mine, handlerFile: mine.mjs }
  - { name: c9, description: d, handlerFile: c9.mjs }
mcp:
  - { serverName: s2, transport: streamable-http, url: 'http://h/mcp', headers: { Authorization: 'Bearer x' } }
  - { serverName: s1, enabled: false }
  - { serverName: s4, transport: stdio, command: node }
hooks:
  tools/pre-execute:
    - { command: local-1 }
  tools/post-execute:
    - { command: local-post }
`;
  // only shared
  const onlyShared = await loadSettings(ws('only-shared', SHARED));
  check('local: only shared', [onlyShared.ok, onlyShared.localFile, onlyShared.settings.mcp.map((m) => m.serverName), onlyShared.warnings.length], [true, undefined, ['s1', 's2', 's3'], 0]);
  // only local: not loaded at all
  check('local: only local -> nothing', await loadSettings(ws('only-local', undefined, LOCAL)), undefined);
  // both
  const both = await loadSettings(ws('both', SHARED, LOCAL));
  check('local: both ok', [both.ok, path.basename(both.localFile), both.warnings.length], [true, 'settings.local.yml', 0]);
  const S = both.settings;
  check('local: subagents replace in place + append', S.subagents.map((s) => [s.toolName, s.personaFile]), [['a', 'a-local.md'], ['b', 'b.md'], ['z', 'z.md']]);
  check('local: commands replace in place + append', S.commands.map((c) => [c.name, c.handlerFile]), [['c1', 'mine.mjs'], ['c2', 'c2.mjs'], ['c9', 'c9.mjs']]);
  check('local: mcp replace in place, remove, append', S.mcp.map((m) => [m.serverName, m.transport]), [['s2', 'streamable-http'], ['s3', 'stdio'], ['s4', 'stdio']]);
  check('local: mcp replaced whole (no stdio fields left)', 'command' in S.mcp[0], false);
  check('local: hooks shared first, local appended', S.hooks['tools/pre-execute'].map((h) => h.command), ['shared-1', 'shared-2', 'local-1']);
  check('local: hooks other events', [S.hooks['agent/pre-step'].map((h) => h.command), S.hooks['tools/post-execute'].map((h) => h.command)], [['shared-step'], ['local-post']]);
  check('local: origin marks', [[...both.origin.subagents], [...both.origin.commands], [...both.origin.mcp]],
    [[['a', 'override'], ['z', 'local']], [['c1', 'override'], ['c9', 'local']], [['s2', 'override'], ['s4', 'local']]]);
  check('local: hooksLocal', both.hooksLocal, { 'tools/pre-execute': 1, 'tools/post-execute': 1 });
  check('local: removed', both.removed, [{ kind: 'mcp', name: 's1' }]);

  // hooks run order through the real mountHooks: shared then local
  {
    const ran = [];
    const listeners = {};
    const shell = { resolve: (req) => req, execute: async (spec) => { ran.push(spec.command.split('\n')[0]); return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }; } };
    const fakeCtx = { inject: (deps, fn) => { fn({ on: (e, cb) => { listeners[e] = cb; }, effect: () => {}, get: (n) => (n === 'shell' ? shell : undefined) }); return {}; } };
    mountHooks(fakeCtx, { hooks: S.hooks, root: tmp, log: quietLog, label: 't', stats: { runs: 0, failures: 0 } });
    await listeners['tools/pre-execute']({ name: 'read', agent: { id: 'x', session: { header: { cwd: tmp } } }, arguments: {}, callId: 'c', signal: new AbortController().signal }, async () => ({ kind: 'allow' }));
    check('local: hooks execution order', ran, ['shared-1', 'shared-2', 'local-1']);
  }

  // enabled: false in shared -> warning, entry kept; enabled in hooks -> unknown field
  const sharedEnabled = await loadSettings(ws('shared-enabled', 'mcp:\n  - { serverName: k, transport: stdio, command: node, enabled: false }\nhooks:\n  agent/pre-step:\n    - { command: x, enabled: false }\n'));
  check('local: enabled in shared ignored, entry kept', sharedEnabled.settings.mcp.map((m) => m.serverName), ['k']);
  check('local: enabled in shared warns (zh/en)', [inLang('zh', () => `${sharedEnabled.warnings[0]}`), inLang('en', () => `${sharedEnabled.warnings[0]}`)],
    ['settings.yml：mcp[0] (k)：enabled 只能写在 settings.local.yml 里，已忽略', 'settings.yml: mcp[0] (k): enabled only works in settings.local.yml; ignored']);
  truthy('local: enabled on a hook is an unknown field', inLang('en', () => `${sharedEnabled.warnings[1]}`).includes('unknown field "enabled"'));

  // enabled: false for a name not in shared; enabled: 'no' is skipped; enabled: true keeps
  const odd = await loadSettings(ws('odd', 'mcp:\n  - { serverName: k, transport: stdio, command: node }\n',
    'mcp:\n  - { serverName: ghost, enabled: false }\n  - { serverName: k, enabled: "no", transport: stdio, command: other }\n  - { serverName: t, enabled: true, transport: stdio, command: node }\n'));
  check('local: odd enabled results', [odd.settings.mcp.map((m) => [m.serverName, m.command]), odd.removed], [[['k', 'node'], ['t', 'node']], []]);
  const oddEn = inLang('en', () => odd.warnings.map(String));
  check('local: odd enabled warnings', oddEn, [
    'settings.local.yml: mcp[1] (k): enabled must be true or false; skipped',
    'settings.local.yml: mcp[0] (ghost): no entry of that name in settings.yml; enabled: false has no effect',
  ]);

  // a bad local entry is skipped; the shared one of the same name stays
  const badEntry = await loadSettings(ws('bad-entry', SHARED, 'mcp:\n  - { serverName: s2, transport: ftp }\nsubagents:\n  - { toolName: a }\n'));
  check('local: bad entry keeps shared', [badEntry.settings.mcp.map((m) => [m.serverName, m.transport]), badEntry.settings.subagents.map((s) => s.personaFile), [...badEntry.origin.mcp]],
    [[['s1', 'stdio'], ['s2', 'stdio'], ['s3', 'stdio']], ['a.md', 'b.md'], []]);
  check('local: bad entry warnings name the file (zh)', inLang('zh', () => badEntry.warnings.map(String)), [
    'settings.local.yml：subagents[0] (a)：缺少 personaFile，已跳过',
    'settings.local.yml：mcp[0] (s2)：transport 只能是 stdio 或 streamable-http，已跳过',
  ]);
  // invalid matcher in local is dropped with the file name
  const badMatcher = await loadSettings(ws('bad-matcher', SHARED, 'hooks:\n  tools/pre-execute:\n    - { matcher: "(", command: x }\n'));
  check('local: bad matcher dropped', badMatcher.settings.hooks['tools/pre-execute'].map((h) => h.command), ['shared-1', 'shared-2']);
  truthy('local: bad matcher warning prefixed', inLang('en', () => `${badMatcher.warnings[0]}`).startsWith('settings.local.yml: hooks.tools/pre-execute[0]:'));

  // broken local YAML / non-mapping / too big: whole local ignored, shared intact
  const SECRET = 'SEKRIT-7f3a9c';
  for (const [name, text, en, zh] of [
    ['yaml', `mcp:\n  - serverName: s2\n    headers: { Authorization: Bearer ${SECRET}\n  x: [`, 'settings.local.yml: YAML parse error at line 4, column 3; the whole file is ignored', 'settings.local.yml：YAML 解析失败（第 4 行第 3 列），整份文件已忽略'],
    ['list', '- 1\n', 'settings.local.yml: must be a mapping at the top level; the whole file is ignored', 'settings.local.yml：顶层必须是映射，整份文件已忽略'],
    ['big', `# ${'x'.repeat(1024 * 1024)}\n`, 'settings.local.yml: exceeds 1MB; the whole file is ignored', 'settings.local.yml：超过 1MB，整份文件已忽略'],
  ]) {
    const r = await loadSettings(ws(`broken-${name}`, SHARED, text));
    check(`local: broken ${name} -> shared intact`, [r.ok, r.settings.mcp.map((m) => m.serverName), Object.keys(r.origin.mcp).length, r.removed], [true, ['s1', 's2', 's3'], 0, []]);
    check(`local: broken ${name} warning`, [inLang('en', () => r.warnings.map(String)), inLang('zh', () => r.warnings.map(String))], [[en], [zh]]);
    truthy(`local: broken ${name} localFile shown`, r.localFile?.endsWith('settings.local.yml'));
  }
  // broken shared: error names settings.yml; local not read
  const brokenShared = await loadSettings(ws('broken-shared', `a: [ ${SECRET}`, LOCAL));
  check('local: broken shared', [brokenShared.ok, brokenShared.localFile, inLang('en', () => `${brokenShared.error}`)], [false, undefined, 'settings.yml: YAML parse error at line 1, column 19']);
  check('local: yaml error hides source text', inLang('en', () => `${brokenShared.error}`).includes(SECRET), false);
  // a directory named settings.local.yml is ignored silently
  const dirLocal = ws('dir-local', SHARED);
  mk('local', 'dir-local', '.dsh', 'settings.local.yml');
  const dl = await loadSettings(dirLocal);
  check('local: directory ignored silently', [dl.localFile, dl.warnings.length], [undefined, 0]);
  // .dsh as a link: both files come from the link target
  {
    const shared = mk('local', 'linked-target');
    write(path.join(shared, 'settings.yml'), SHARED);
    write(path.join(shared, 'settings.local.yml'), LOCAL);
    const w = mk('local', 'linked-ws');
    fs.symlinkSync(shared, path.join(w, '.dsh'), 'junction');
    const r = await loadSettings(w);
    check('local: .dsh link reads local from target', [r.ok, r.settings.mcp.map((m) => m.serverName)], [true, ['s2', 's3', 's4']]);
  }
  // pure merge: empty local is a no-op
  const base = { subagents: [{ toolName: 'a' }], commands: [], mcp: [], hooks: { 'agent/pre-step': [{ command: 'x' }] } };
  const noop = mergeSettings(base, { subagents: [], commands: [], mcp: [], hooks: {} });
  check('merge: empty local no-op', [noop.settings, noop.removed, noop.warnings], [base, [], []]);

  // /project-config marks, both languages
  const m = { root: tmp, file: both.file, localFile: both.localFile, ok: true, trust: 'untrusted', warnings: [], gatedWarnings: [],
    subagentSpecs: S.subagents.map((entry) => ({ entry })), deferredSpecs: [], settings: S, origin: both.origin, hooksLocal: both.hooksLocal, removed: both.removed, stats: { runs: 0, failures: 0 } };
  const zh = inLang('zh', () => statusText(m, { hasTrust: true, logFile: 'L' })).split('\n');
  const en = inLang('en', () => statusText(m, { hasTrust: true, logFile: 'L' })).split('\n');
  check('status local: zh', zh.slice(1), [
    `配置文件：${both.file} + ${both.localFile}`,
    '信任：不信任',
    '子代理：a (local 覆盖), b, z (local)',
    '命令（需要信任）：/c1 (local 覆盖), /c2, /c9 (local)',
    'MCP（需要信任）：s2 (local 覆盖), s3, s4 (local)',
    'Hooks（需要信任）：tools/pre-execute ×3（local 1）, agent/pre-step ×1, tools/post-execute ×1（local 1）',
    '已移除（local enabled: false）：MCP s1',
    '日志：L',
  ]);
  check('status local: en', en.slice(1), [
    `Settings: ${both.file} + ${both.localFile}`,
    'Trust: Not trusted',
    'Subagents: a (local override), b, z (local)',
    'Commands (requires trust): /c1 (local override), /c2, /c9 (local)',
    'MCP (requires trust): s2 (local override), s3, s4 (local)',
    'Hooks (requires trust): tools/pre-execute ×3 (local 1), agent/pre-step ×1, tools/post-execute ×1 (local 1)',
    'Removed (local enabled: false): MCP s1',
    'Log: L',
  ]);
  check('status local: en has no chinese', CJK.test(en.join('\n')), false);
  const connected = { ...m, trust: 'trusted', hub: { summary: () => [{ name: 's2', status: 'connected', detail: TEXT.tools(2) }] } };
  truthy('status local: connected server marked', inLang('zh', () => statusText(connected, { hasTrust: true, logFile: 'L' })).includes('MCP s2 (local 覆盖)：✓ 已连接 — 2 个工具'));
}

// ---------------------------------------------------------------- secrets stay out of logs and status
{
  const SECRET = 'SEKRIT-7f3a9c';
  const { secretsOf, redact } = await import('../lib/features/mcp.js');
  const cfg = { serverName: 'knot', transport: 'streamable-http', url: `https://u:${SECRET}p@knot.example/mcp?key=${SECRET}q`, headers: { Authorization: `Bearer ${SECRET}`, 'X-Api-Key': `${SECRET}k` } };
  const msg = `HTTP POST ${cfg.url} failed: 401 (${cfg.headers.Authorization}; raw ${SECRET}; host knot.example)`;
  const cleaned = redact(msg, secretsOf(cfg));
  check('redact: no secret left', [cleaned.includes(SECRET), cleaned.includes('knot.example')], [false, false]);
  truthy('redact: scheme kept', cleaned.includes('Bearer ***') || cleaned.includes('***'));
  check('redact: short values ignored', secretsOf({ headers: { A: 'x' } }), []);

  // a real hub + connection, with a client whose errors quote the resolved url and token
  const logFile = path.join(tmp, 'secret.log');
  const log = createLog(logFile);
  const hub = new McpHub(log, '[w:1]');
  const port = 45678;
  const entry = { serverName: 'knot', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp?token=\${PCFG_TEST_Q}`, headers: { Authorization: `Bearer ${SECRET}` }, reconnect: { enabled: false } };
  let seenConfig;
  const fake = fakeMcp();
  fake.connectError = (config) => new Error(`HTTP POST ${config.url} failed: 401 ${config.headers.Authorization}; server said: bad token ${SECRET}`);
  await hub.startIn(fakeScope(), [entry], (e) => resolveServerConfig(e, tmp, async () => ({ ok: false }), { PCFG_TEST_Q: `${SECRET}q` }),
    { transportFactory: (config) => { seenConfig = config; return fake.transportFactory(config); }, clientFactory: fake.clientFactory });
  check('secrets: connection got real values', [seenConfig.headers.Authorization, seenConfig.url.endsWith(`${SECRET}q`)], [`Bearer ${SECRET}`, true]);
  const summary = hub.summary();
  const status = inLang('en', () => statusText({ root: tmp, file: 'F', ok: true, trust: 'trusted', warnings: [], gatedWarnings: [], subagentSpecs: [], deferredSpecs: [],
    settings: { subagents: [], commands: [], mcp: [entry], hooks: {} }, hub, stats: { runs: 0, failures: 0 } }, { hasTrust: true, logFile }));
  const logText = fs.readFileSync(logFile, 'utf8');
  check('secrets: server failed', summary[0].status, 'failed');
  truthy('secrets: something was logged', logText.length > 0);
  check('secrets: not in log', logText.includes(SECRET), false);
  check('secrets: not in status', status.includes(SECRET), false);
  check('secrets: url not in log or status', [logText.includes(`127.0.0.1:${port}`), status.includes(`127.0.0.1:${port}`)], [false, false]);
  await hub.disposeAll();
}

// ---------------------------------------------------------------- MCP connection: real state, reconnect
{
  const { McpConnection, publicToolName, resolveReconnectPolicy, isConnectionError } = await import('../lib/features/mcp-connection.js');
  const { publicToolName: officialName } = await officialInternals();
  // tool names identical to the official client
  for (const [srv, raw] of [['knot', 'search'], ['k', 'a.b/c'], ['server', 'x'.repeat(80)], ['s-1', 'ok_name']]) {
    check(`names: ${srv}/${raw.slice(0, 12)} same as official`, publicToolName(srv, raw), officialName(srv, raw));
  }
  check('policy: defaults', resolveReconnectPolicy(undefined), { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 });
  let threw;
  try { resolveReconnectPolicy({ attempts: 3 }); } catch (e) { threw = e.message; }
  check('policy: unknown key rejected', threw, 'reconnect.attempts is not a reconnect option');
  check('connection error: typed codes only', [isConnectionError({ code: 'CONNECTION_CLOSED' }), isConnectionError({ code: 'REQUEST_TIMEOUT' }), isConnectionError(new Error('connection closed')), isConnectionError({ cause: { code: 'ECONNREFUSED' } })], [true, false, false, true]);

  // a manual clock and timers
  let now = 1000;
  const timers = [];
  const clock = { now: () => now, setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } };
  const fire = async () => { const t = timers.shift(); now = t.at; t.fn(); await settle(); };
  const fake = fakeMcp();
  const registered = new Map();
  const conn = new McpConnection({ serverName: 'k', transport: 'streamable-http', url: 'http://h/mcp' }, {
    ctx: {}, register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name); }, log: quietLog, ...clock,
    transportFactory: fake.transportFactory, clientFactory: fake.clientFactory,
  });
  const view = () => { const st = conn.status(); return [st.state, st.tools, st.error, st.attempt]; };
  // 1. server down at start: retrying with the real error object
  fake.connectError = () => Object.assign(new Error('Version negotiation failed: the server requires authorization (HTTP 401)'), { code: 'CLIENT_HTTP_AUTHENTICATION' });
  await conn.start();
  check('conn: first attempt fails -> retrying', view(), ['retrying', 0, 'Version negotiation failed: the server requires authorization (HTTP 401)', { n: 1, max: 10 }]);
  check('conn: backoff 500ms', timers[0].at - now, 500);
  await fire();
  check('conn: second failure -> attempt 2, 1000ms', [view()[0], view()[3], timers[0].at - now], ['retrying', { n: 2, max: 10 }, 1000]);
  // 2. server comes up: next attempt connects, tools registered
  fake.connectError = undefined;
  fake.tools = [{ name: 'whoami', inputSchema: { type: 'object', properties: {} } }];
  await fire();
  check('conn: connected with tools, error cleared', view(), ['connected', 1, undefined, undefined]);
  check('conn: official tool name registered', [...registered.keys()], ['mcp__k__whoami']);
  // a tool call goes to the live client
  fake.callResult = { content: [{ type: 'text', text: 'you are k' }] };
  const def = registered.get('mcp__k__whoami');
  const callOut = await def.execute({}, { signal: new AbortController().signal, agent: undefined });
  check('conn: call result through official definition', callOut.content[0].text, 'you are k');
  // 3. tools/list_changed re-syncs
  fake.tools = [{ name: 'whoami', inputSchema: { type: 'object' } }, { name: 'echo', inputSchema: { type: 'object' } }];
  await fake.current.listChanged();
  await settle();
  check('conn: list_changed re-synced', [...registered.keys()].sort(), ['mcp__k__echo', 'mcp__k__whoami']);
  // 4. transport closes: reconnecting, tools kept (official behaviour), error recorded
  fake.connectError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  fake.current.closeFromServer();
  await settle();
  // up for less than maxDelayMs: same outage, the budget continues (official rule)
  check('conn: lost -> reconnecting, tools kept, budget continues', [view()[0], view()[1], view()[3]], ['reconnecting', 2, { n: 3, max: 10 }]);
  await fire();
  check('conn: reconnect attempt failed -> cause with network code', [view()[0], view()[2]], ['reconnecting', 'fetch failed (ECONNREFUSED)']);
  // a call during the outage fails clearly
  let callErr;
  try { await registered.get('mcp__k__echo').execute({}, { signal: new AbortController().signal }); } catch (e) { callErr = String(e.message); }
  truthy('conn: call while down explains state', callErr?.includes('not connected (reconnecting'));
  // 5. exhaust the budget -> failed, tools removed
  while (timers.length) await fire();
  check('conn: gave up -> failed, tools removed', [view()[0], view()[1], view()[2]], ['failed', 0, 'fetch failed (ECONNREFUSED)']);
  // 6. manual reconnect brings it back at once, fresh budget
  fake.connectError = undefined;
  const after = await conn.reconnect();
  check('conn: manual reconnect -> connected', [after.state, after.tools, conn.attempt], ['connected', 2, 0]);
  // 7. a call failing at the transport level marks the connection lost
  fake.callError = Object.assign(new Error('Connection closed'), { code: 'CONNECTION_CLOSED' });
  fake.connectError = () => new Error('still down');
  try { await registered.get('mcp__k__echo').execute({}, { signal: new AbortController().signal }); } catch { /* expected */ }
  await settle();
  check('conn: transport error on call -> reconnecting', [view()[0], view()[2]], ['reconnecting', 'Connection closed']);
  // a JSON-RPC error answer does not
  fake.connectError = undefined; fake.callError = undefined;
  await conn.reconnect();
  const { ProtocolError } = await import('@modelcontextprotocol/client');
  fake.callError = new ProtocolError(-32602, 'bad args');
  try { await registered.get('mcp__k__echo').execute({}, { signal: new AbortController().signal }); } catch { /* expected */ }
  check('conn: protocol error keeps connected', view()[0], 'connected');
  fake.callError = undefined;
  // 8. ping check: dead server found without a call
  fake.pingError = Object.assign(new Error('Connection closed'), { code: 'CONNECTION_CLOSED' });
  fake.connectError = () => new Error('down');
  await conn.check();
  check('conn: ping failure -> reconnecting', view()[0], 'reconnecting');
  fake.pingError = undefined;
  // 9. reconnect while retrying cancels the timer
  fake.connectError = undefined;
  const pending = timers.length;
  await conn.reconnect();
  check('conn: reconnect cancels pending retry', [pending > 0, timers.length, view()[0]], [true, 0, 'connected']);
  // 10. stable connection resets the budget after a drop
  now += 31000;
  fake.connectError = () => new Error('down');
  conn.attempt = 7;
  fake.current.closeFromServer();
  await settle();
  check('conn: stable >= maxDelayMs resets budget', view()[3], { n: 1, max: 10 });
  // 11. reconnect disabled
  const fake2 = fakeMcp();
  fake2.connectError = () => new Error('nope');
  const c2 = new McpConnection({ serverName: 'd', transport: 'stdio', command: 'x', reconnect: { enabled: false } }, { ctx: {}, register: () => () => {}, log: quietLog, ...clock, transportFactory: fake2.transportFactory, clientFactory: fake2.clientFactory });
  await c2.start();
  check('conn: reconnect disabled -> failed at once', [c2.status().state, c2.status().error], ['failed', 'nope']);
  // stdio stderr tail is part of the reason
  const fake3 = fakeMcp();
  fake3.stderrText = 'line1\nError: missing API key\n';
  fake3.connectError = () => Object.assign(new Error('Connection closed'), { code: 'CONNECTION_CLOSED' });
  const c3 = new McpConnection({ serverName: 's', transport: 'stdio', command: 'x', reconnect: { enabled: false } }, { ctx: {}, register: () => () => {}, log: quietLog, ...clock, transportFactory: fake3.transportFactory, clientFactory: fake3.clientFactory });
  await c3.start();
  check('conn: stdio stderr tail in reason', c3.status().error, 'Connection closed | stderr: line1 / Error: missing API key');
  // a tool name the scope already holds: failed at once, no retry, child closed
  const fake4 = fakeMcp();
  fake4.tools = [{ name: 'echo', inputSchema: { type: 'object' } }];
  let tx4;
  const timersBefore = timers.length;
  const c4 = new McpConnection({ serverName: 'dup', transport: 'stdio', command: 'x' }, {
    ctx: {}, register: (d) => { throw new Error(`tool "${d.name}" is already registered in this scope`); }, log: quietLog, ...clock,
    transportFactory: (config) => (tx4 = fake4.transportFactory(config)), clientFactory: fake4.clientFactory,
  });
  await c4.start();
  check('conn: name clash -> failed, no retry', [c4.status().state, c4.status().attempt, timers.length - timersBefore], ['failed', undefined, 0]);
  check('conn: name clash reason', c4.status().error, 'tool registration failed: tool "mcp__dup__echo" is already registered in this scope');
  check('conn: name clash closes the connection', [tx4.closed || fake4.current.transport === undefined, c4.gen], [true, undefined]);
  // a manual reconnect tries again once the clash is gone
  const reg4 = new Map();
  c4.register = (d) => { reg4.set(d.name, d); return () => reg4.delete(d.name); };
  check('conn: reconnect after clash -> connected', (await c4.reconnect()).state, 'connected');
  await c4.dispose();
  // 12. dispose stops everything
  await conn.dispose();
  check('conn: dispose -> stopped, tools removed, no timers', [conn.status().state, registered.size, timers.length], ['stopped', 0, 0]);
  await c2.dispose(); await c3.dispose();

  // hub: reconnect by name / all-not-connected, summary text
  const fakeH = fakeMcp();
  fakeH.tools = [{ name: 't', inputSchema: { type: 'object' } }];
  const hub = new McpHub(quietLog, 't');
  const scope = fakeScope();
  let downName = 'b';
  const factories = {
    ...clock,
    transportFactory: (config) => { const t = fakeH.transportFactory(config); t.serverName = config.serverName; return t; },
    clientFactory: fakeH.clientFactory,
  };
  fakeH.connectError = (config) => (config.serverName === downName ? Object.assign(new Error('HTTP 401'), { code: 'CLIENT_HTTP_AUTHENTICATION' }) : undefined);
  await hub.startIn(scope, [{ serverName: 'a' }, { serverName: 'b' }, { serverName: 'c' }], async (e) => (e.serverName === 'c' ? { error: 'cwd: bad' } : { config: { serverName: e.serverName, transport: 'streamable-http', url: 'http://h/' + e.serverName } }), factories);
  const sum = () => hub.summary().map((x) => [x.name, x.status, x.detail === undefined ? undefined : inLang('en', () => `${x.detail}`)]);
  check('hub: summary', sum(), [['a', 'connected', '1 tool'], ['b', 'retrying', 'HTTP 401 (retry 1/10)'], ['c', 'skipped', 'cwd: bad']]);
  check('hub: instructions + resources registered', [scope.sections.map((x) => x.name), scope.resources], [['mcp:a', 'mcp:b'], ['a', 'b']]);
  downName = undefined;
  check('hub: reconnect all -> only not-connected', await hub.reconnect(), ['b']);
  check('hub: b connected now', sum()[1], ['b', 'connected', '1 tool']);
  check('hub: reconnect all when all up -> nothing', await hub.reconnect(), []);
  check('hub: reconnect connected one by name', await hub.reconnect('a'), ['a']);
  check('hub: unknown name', await hub.reconnect('zz'), undefined);
  check('hub: skipped server cannot reconnect', await hub.reconnect('c'), []);
  // reconnect output, both languages
  const root = { hub, origin: { mcp: new Map([['b', 'local']]) } };
  check('reconnect text', [inLang('zh', () => reconnectText(root, ['b'])), inLang('en', () => reconnectText(root, ['b']))],
    ['MCP b (local)：✓ 已连接 — 1 个工具', 'MCP b (local): ✓ connected — 1 tool']);
  await hub.disposeAll();
  check('hub: disposeAll stops connections', hub.summary().map((x) => x.status), ['stopped', 'stopped', 'skipped']);

  check('mcp state: zh labels', inLang('zh', () => [`${TEXT.mcpState.retrying}`, `${TEXT.mcpState.reconnecting}`, `${TEXT.mcpRetry('X', { n: 2, max: 10 })}`, `${TEXT.tools(1)}`]),
    ['✗ 连接失败，重试中', '⟳ 连接断开，重连中', 'X（第 2/10 次重试）', '1 个工具']);
  check('mcp state: en plural', inLang('en', () => [`${TEXT.tools(0)}`, `${TEXT.tools(1)}`, `${TEXT.tools(2)}`]), ['0 tools', '1 tool', '2 tools']);
  const m = { root: tmp, file: 'F', ok: true, trust: 'trusted', warnings: [], gatedWarnings: [], subagentSpecs: [], deferredSpecs: [], settings: { subagents: [], commands: [], mcp: [{ serverName: 'k' }], hooks: {} }, stats: { runs: 0, failures: 0 },
    hub: { summary: () => [{ name: 'k', status: 'retrying', detail: TEXT.mcpRetry('HTTP 401', { n: 1, max: 10 }) }] } };
  truthy('mcp state: status line en', inLang('en', () => statusText(m, { hasTrust: true, logFile: 'L' })).includes('MCP k: ✗ failed, retrying — HTTP 401 (retry 1/10)'));
  truthy('mcp state: status line zh', inLang('zh', () => statusText(m, { hasTrust: true, logFile: 'L' })).includes('MCP k：✗ 连接失败，重试中 — HTTP 401（第 1/10 次重试）'));
}
{
  const { DEFAULT_LOG_FILE } = await import('../lib/log.js');
  check('log: default path has no 8.3 short names', /~\d/.test(DEFAULT_LOG_FILE), false);
  check('log: default path is the real temp dir', path.dirname(DEFAULT_LOG_FILE), fs.realpathSync.native(os.tmpdir()));
}

// ---------------------------------------------------------------- filters / tools interception
check('admits: no filter', admits(undefined, 'x'), true);
check('admits: allow', [admits({ allow: ['a'] }, 'a'), admits({ allow: ['a'] }, 'b')], [true, false]);
check('admits: deny', admits({ deny: ['a'] }, 'a'), false);
const isProj = (n) => n === 'doc' || n.startsWith('mcp__');
check('officialFilter: strips project names', officialFilter({ allow: ['read', 'doc', 'mcp__s__t'] }, isProj), { allow: ['read'] });
check('officialFilter: allow emptied stays empty', officialFilter({ allow: ['doc'] }, isProj), { allow: [] });
check('officialFilter: deny only project -> undefined', officialFilter({ deny: ['doc'] }, isProj), undefined);
check('officialFilter: deny kept', officialFilter({ deny: ['pwsh', 'doc'] }, isProj), { deny: ['pwsh'] });
check('officialFilter: per-agent subagent tools dropped from allow', officialFilter({ allow: ['read', 'subagent', 'list_subagent_models'] }, isProj), { allow: ['read'] });
check('officialFilter: per-agent subagent tool dropped from deny', officialFilter({ deny: ['subagent'] }, isProj), undefined);
check('officialFilter: inherited subagent_fork kept', officialFilter({ allow: ['subagent_fork'] }, isProj), { allow: ['subagent_fork'] });
{
  const seen = [];
  const real = { register: (d) => { seen.push(d.name); return () => seen.push(`-${d.name}`); }, get: (n) => `got:${n}`, [Symbol.for('cordis.tracker')]: { property: 'ctx' } };
  const t = interceptTools(real, (d, reg) => reg({ ...d, name: `w:${d.name}` }));
  const dispose = t.register({ name: 'a' });
  dispose();
  check('intercept: register wrapped', seen, ['w:a', '-w:a']);
  check('intercept: other methods pass through', t.get('z'), 'got:z');
  check('intercept: tracker hidden', t[Symbol.for('cordis.tracker')], undefined);
}
truthy('roster: lists names', rosterText([{ entry: { toolName: 'doc' }, description: 'docs' }]).includes('`doc`: docs'));

// ---------------------------------------------------------------- MCP config + hub mirror
{
  const checkTarget = (root, rel) => builtinCheckTarget(root, rel, { type: 'directory' });
  mk('repo', 'pkg', 'tools');
  const r1 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', args: ['${A}'], env: { T: '${B}' } }, sub, checkTarget, { A: 'x', B: 'y' });
  check('mcp cfg: stdio expanded, cwd root', r1.config, { serverName: 's', transport: 'stdio', command: 'node', args: ['x'], env: { T: 'y' }, cwd: sub });
  const r2 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', cwd: 'tools' }, sub, checkTarget, {});
  check('mcp cfg: cwd resolved', r2.config.cwd, path.join(sub, 'tools'));
  const r3 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', cwd: 'link-out' }, sub, checkTarget, {});
  truthy('mcp cfg: cwd outside refused', inLang('en', () => String(r3.error)).startsWith('cwd: Path is outside'));
  truthy('mcp cfg: cwd outside refused (zh)', inLang('zh', () => String(r3.error)).startsWith('cwd：路径在工作区外'));
  const r4 = await resolveServerConfig({ serverName: 'w', transport: 'streamable-http', url: 'http://h/${P}', headers: { A: 'Bearer ${TOK}' } }, sub, checkTarget, {});
  check('mcp cfg: missing vars listed', [inLang('zh', () => `${r4.error}`), inLang('en', () => `${r4.error}`)], ['环境变量未设置：P, TOK', 'environment variable not set: P, TOK']);

  const hub = new McpHub(quietLog, 't');
  const rootReg = [];
  const unregA = hub.track({ name: 'mcp__s__a' }, (d) => { rootReg.push(d.name); return () => rootReg.push(`-${d.name}`); });
  hub.track({ name: 'mcp__s__b' }, (d) => { rootReg.push(d.name); return () => {}; });
  const childReg = new Map();
  let effectDispose;
  const childCtx = {
    inject: (deps, fn) => {
      fn({ tools: { register: (d) => { childReg.set(d.name, d); return () => childReg.delete(d.name); } }, effect: (f) => { effectDispose = f(); } });
      return { dispose: () => effectDispose() };
    },
  };
  const fiber = hub.mirror(childCtx, { allow: ['mcp__s__a', 'read'] });
  check('mirror: filtered initial', [...childReg.keys()], ['mcp__s__a']);
  unregA();
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => setTimeout(r, 0));
  check('mirror: removal follows root', [...childReg.keys()], []);
  hub.track({ name: 'mcp__s__a' }, () => () => {});
  await new Promise((r) => setTimeout(r, 0));
  check('mirror: re-added follows root', [...childReg.keys()], ['mcp__s__a']);
  const open = new Map();
  const childCtx2 = { inject: (deps, fn) => { let d; fn({ tools: { register: (x) => { open.set(x.name, x); return () => open.delete(x.name); } }, effect: (f) => { d = f(); } }); return { dispose: () => d() }; } };
  hub.mirror(childCtx2, undefined);
  check('mirror: no filter gets all', [...open.keys()].sort(), ['mcp__s__a', 'mcp__s__b']);
  fiber.dispose();
  check('mirror: dispose cleans up', [childReg.size, hub.mirrors.size], [0, 1]);
}

// ---------------------------------------------------------------- hooks
{
  const v = validateHookMatchers({ 'tools/pre-execute': [{ matcher: '(', command: 'a' }, { matcher: 'pwsh', command: 'b' }] });
  check('hooks: invalid regex dropped', [v.hooks['tools/pre-execute'].map((h) => h.command), v.warnings.length], [['b'], 1]);

  const listeners = {};
  let outcome = { exitCode: 0, stdout: '', stderr: '' };
  const requests = [];
  const shell = {
    resolve: (req) => req,
    execute: async (spec) => { requests.push(spec); return { result: async () => ({ exitCode: outcome.exitCode, stdout: { text: outcome.stdout }, stderr: { text: outcome.stderr } }) }; },
  };
  const policy = { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) };
  const fakeCtx = {
    inject: (deps, fn) => { fn({ on: (e, cb) => { listeners[e] = cb; }, effect: () => {}, get: (n) => (n === 'shell' ? shell : n === 'sandboxPolicy' ? policy : undefined) }); return {}; },
  };
  const stats = { runs: 0, failures: 0 };
  mountHooks(fakeCtx, {
    hooks: {
      'tools/pre-execute': [{ matcher: 'pwsh', command: 'check' }],
      'tools/post-execute': [{ command: 'post' }],
      'agent/pre-step': [{ command: 'prompt' }],
      'agent/turn-stopping': [{ command: 'stop' }],
    },
    root: sub, log: quietLog, label: 't', stats,
  });
  const agent = { id: 'a1', session: { header: { cwd: deep } }, steer: (m) => { agent.steered = m; } };
  const exec = (name) => ({ name, agent, arguments: { c: 1 }, callId: 'c1', signal: new AbortController().signal });
  const next = async () => ({ kind: 'allow' });
  check('hooks: matcher skip', await listeners['tools/pre-execute'](exec('read'), next), { kind: 'allow' });
  check('hooks: no run on skip', requests.length, 0);
  outcome = { exitCode: 2, stdout: '', stderr: 'not allowed' };
  check('hooks: exit 2 denies', await listeners['tools/pre-execute'](exec('pwsh'), next), { kind: 'deny', reason: 'not allowed' });
  const req = requests[0];
  const payload = JSON.parse(req.stdin);
  check('hooks: payload', [payload.event, payload.tool_name, payload.workspace_root, payload.cwd], ['tools/pre-execute', 'pwsh', sub, deep]);
  check('hooks: cwd/env/policy', [req.workdir, req.env.DSH_PROJECT_DIR, req.sandboxPolicy.workspaceRoot], [sub, sub, deep]);
  check('hooks: command forwarded', req.command, forwardExitCode('check'));
  check('hooks: exit forward win32', forwardExitCode('x', 'win32').endsWith('exit $LASTEXITCODE }'), true);
  check('hooks: exit forward posix untouched', forwardExitCode('x', 'linux'), 'x');
  outcome = { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'sure?' } }), stderr: '' };
  check('hooks: JSON ask', await listeners['tools/pre-execute'](exec('pwsh'), next), { kind: 'ask', reason: 'sure?' });
  outcome = { exitCode: 1, stdout: '', stderr: 'boom' };
  check('hooks: other exit passes', await listeners['tools/pre-execute'](exec('pwsh'), next), { kind: 'allow' });
  outcome = { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'note' } }), stderr: '' };
  const post = await listeners['tools/post-execute'](exec('read'), { content: [{ type: 'text', text: 'r' }] }, async () => ({ kind: 'accept' }));
  check('hooks: post adds context', [post.kind, post.additionalContexts?.[0]?.content?.[0]?.text], ['accept', 'note']);
  outcome = { exitCode: 2, stdout: '', stderr: 'bad result' };
  const blocked = await listeners['tools/post-execute'](exec('read'), { content: [] }, async () => ({ kind: 'accept' }));
  check('hooks: post block', [blocked.kind, blocked.feedback[0].text], ['block', 'bad result']);
  check('hooks: pre-step no messages skips', await listeners['agent/pre-step']({ agent, messages: [], signal: undefined }, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] });
  outcome = { exitCode: 2, stdout: '', stderr: '' };
  check('hooks: pre-step reject', await listeners['agent/pre-step']({ agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' });
  await listeners['agent/turn-stopping']({ agent });
  check('hooks: turn-stopping steers', agent.steered?.content?.[0]?.text?.startsWith('continue'), true);
  check('hooks: stats counted', stats.runs > 0, true);
}

// ---------------------------------------------------------------- commands
check('result: string', normalizeResult('hi'), { kind: 'success', text: 'hi' });
check('result: undefined', normalizeResult(undefined), { kind: 'success' });
check('result: error blank', normalizeResult({ kind: 'error', text: ' ' }), { kind: 'error', text: 'command failed' });
check('result: object', normalizeResult({ a: 1 }).text, '{\n  "a": 1\n}');
{
  const f = write(path.join(tmp, 'cmd', 'h.mjs'), 'export default ({ rawInput }) => `v1:${rawInput}`;');
  check('handler: default export', await (await loadHandler(f))({ rawInput: 'x' }), 'v1:x');
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(f, 'export function handler() { return "v2"; }');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(f, later, later);
  check('handler: reload on change', await (await loadHandler(f))({}), 'v2');
  const bad = write(path.join(tmp, 'cmd', 'bad.mjs'), 'export const x = 1;');
  let threw = false;
  try { await loadHandler(bad); } catch { threw = true; }
  check('handler: missing export throws', threw, true);
}

// ---------------------------------------------------------------- isolation: skill roots (real provider prototype)
{
  const roots = [
    { path: path.join(gitRoot, '.dsh/skills'), source: 'project-dsh', rank: 100, projectRoot: gitRoot },
    { path: path.join(gitRoot, '.agents/skills'), source: 'project-agents', rank: 200, projectRoot: gitRoot },
    { path: '/u/skills', source: 'user-dsh', rank: 400 },
  ];
  const r = await rewriteRoots(roots, deep);
  check('roots: moved to settings root', r.slice(0, 2).map((x) => [x.path, x.projectRoot]), [[path.join(sub, '.dsh', 'skills'), sub], [path.join(sub, '.agents', 'skills'), sub]]);
  check('roots: others untouched', r[2], roots[2]);
  check('roots: no settings -> unchanged', await rewriteRoots(roots, gitRoot), roots);
  const proto = FileSystemSkillProvider.prototype;
  const original = proto.roots;
  const restore = patchSkillRoots(quietLog);
  truthy('roots: prototype patched', proto.roots !== original);
  const restore2 = patchSkillRoots(quietLog);
  const provider = Object.create(proto);
  Object.assign(provider, { includeDefaultRoots: true, customSkillDirs: [], dshHome: path.join(tmp, 'home'), agentsHome: path.join(tmp, 'agents'), bundledSkillDir: undefined, ctx: { get: () => undefined } });
  const live = await provider.roots(deep);
  check('roots: real provider uses settings root', live.filter((x) => x.source.startsWith('project')).map((x) => x.projectRoot), [sub, sub]);
  const plain = await provider.roots(path.join(gitRoot));
  check('roots: real provider unchanged without settings', plain.filter((x) => x.source.startsWith('project')).map((x) => x.projectRoot), [gitRoot, gitRoot]);
  restore2();
  restore();
  check('roots: restored', proto.roots, original);
}

// ---------------------------------------------------------------- isolation: instructions marker
{
  let hook;
  const effects = [];
  const fakeCtx = {
    on: (event, cb) => { if (event === 'internal/config') hook = cb; },
    inject: () => {},
    effect: (f) => effects.push(f),
    registry: { get: () => undefined },
  };
  installInstructionsMarker(fakeCtx, quietLog);
  const run = (callback, cfg) => hook.call({ runtime: { callback } }, cfg, () => cfg);
  check('marker: inserted for agent-instructions', run(instructionsApply, { maxBytes: 1, projectRootMarkers: ['.git'] }).projectRootMarkers, [MARKER, '.git']);
  check('marker: default markers', run(instructionsApply, { maxBytes: 1 }).projectRootMarkers, [MARKER, '.git']);
  check('marker: idempotent', run(instructionsApply, { projectRootMarkers: [MARKER, '.git'] }).projectRootMarkers, [MARKER, '.git']);
  check('marker: other plugins untouched', run(() => {}, { projectRootMarkers: ['.git'] }).projectRootMarkers, ['.git']);
  effects[0]()();
  check('marker: off after dispose', run(instructionsApply, { projectRootMarkers: ['.git'] }).projectRootMarkers, ['.git']);
}

// ---------------------------------------------------------------- status
{
  check('status: no mount', statusText(undefined, { hasTrust: true, logFile: 'L' }).includes('.dsh/settings.yml'), true);
  const m = { root: sub, file: 'F', ok: true, trust: 'untrusted', warnings: ['w1'], gatedWarnings: [], subagentSpecs: [{ entry: { toolName: 'doc' } }], deferredSpecs: [],
    settings: { commands: [{ name: 'hi' }], mcp: [{ serverName: 's' }], hooks: { 'tools/pre-execute': [{}] } }, stats: { runs: 0, failures: 0 } };
  const t = statusText(m, { hasTrust: false, logFile: 'L' });
  for (const needle of ['doc', '/hi', 'MCP（需要信任', 'tools/pre-execute ×1', '未安装 dsh-workspace-trust', '⚠ w1']) truthy(`status: ${needle}`, t.includes(needle));
  // one language at a time, including warnings stored earlier
  const parsed = parseSettings('subagents: [{ toolName: x }]\nskills: []\n');
  const m2 = { ...m, warnings: parsed.warnings, settings: { ...m.settings }, trust: 'trusted', hub: { summary: () => [{ name: 's', status: 'connected', detail: TEXT.tools(3) }] } };
  const zh = inLang('zh', () => statusText(m2, { hasTrust: true, logFile: 'L' }));
  const en = inLang('en', () => statusText(m2, { hasTrust: true, logFile: 'L' }));
  check('status: zh lines', zh.split('\n').slice(0, 3), [`工作区：${sub}`, '配置文件：F', '信任：已信任']);
  check('status: en lines', en.split('\n').slice(0, 3), [`Workspace: ${sub}`, 'Settings: F', 'Trust: Trusted']);
  truthy('status: zh mcp', zh.includes('MCP s：✓ 已连接 — 3 个工具'));
  truthy('status: en mcp', en.includes('MCP s: ✓ connected — 3 tools'));
  check('status: en has no chinese', CJK.test(en), false);
  // config keys such as `tools/pre-execute` stay as written
  check('status: zh has no english sentences', /\b(Workspace|Settings|Trust|Subagents|Commands|connected|tools|skipped|ignored|must)\b/.test(zh.replace(/[a-z]+\/[a-z-]+/g, '')), false);
  // a nested message built while zh is active, shown later in en (and back)
  const nested = inLang('zh', () => TEXT.cwdProblem(TEXT.outsideNoTrust('X')));
  check('status: nested message follows language', [inLang('en', () => `${nested}`), inLang('zh', () => `${nested}`)],
    ['cwd: Path is outside the workspace; not allowed without dsh-workspace-trust: X', 'cwd：路径在工作区外，未安装 dsh-workspace-trust 时不允许：X']);
  check('status: no-mount text per language', [inLang('zh', () => statusText(undefined, { hasTrust: true, logFile: 'L' })).startsWith('此会话'), inLang('en', () => statusText(undefined, { hasTrust: true, logFile: 'L' })).startsWith('No project')], [true, true]);
  // builtin path messages per language
  const missingZh = await builtinCheckTarget(sub, 'nope');
  check('builtin: message per language', [inLang('zh', () => `${missingZh.message}`), inLang('en', () => `${missingZh.message}`)], ['路径不存在：nope', 'Path not found: nope']);
  const esc = await builtinCheckTarget(sub, '../x');
  check('builtin: bad path per language', [inLang('zh', () => `${esc.message}`), inLang('en', () => `${esc.message}`)], ['路径写法不允许：../x（跳出了工作区）', 'Path not allowed: ../x (escapes the workspace)']);
}

// ---------------------------------------------------------------- language source wiring
{
  const { preferenceFromLoader } = await import('../lib/locale.js');
  const loader = { entries: () => [{ options: { name: '@deepseek-ai/dsh-client-locale', config: {} }, fiber: { config: { preference: { get: () => 'en' } } } }][Symbol.iterator]() };
  setLocaleSource(() => preferenceFromLoader(loader));
  check('locale: read from loader', lang(), 'en');
  setLocaleSource(() => uiLang);
}

// ---------------------------------------------------------------- plugin lifecycle (real Cordis, real stdio children)
{
  const { Context } = await import('@deepseek-ai/cordis');
  const plugin = await import('../lib/index.js');
  const proj = mk('life');
  const pidDir = mk('life-pids');
  write(path.join(proj, 'server.mjs'), [
    "import fs from 'node:fs'; import path from 'node:path';",
    "fs.writeFileSync(path.join(process.env.PID_DIR, `${process.pid}.pid`), '');",
    "let buf = ''; const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); if (m.id === undefined) continue;",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });",
    "  else send({ jsonrpc: '2.0', id: m.id, result: {} }); } });",
    "process.stdin.on('end', () => process.exit(0));",
  ].join('\n'));
  write(path.join(proj, '.dsh', 'settings.yml'), `mcp:\n  - serverName: life\n    transport: stdio\n    command: '${process.execPath.replace(/\\/g, '/')}'\n    args: [server.mjs]\n    env: { PID_DIR: '${pidDir.replace(/\\/g, '/')}' }\n`);

  const root = new Context();
  const agents = new Map();
  const sessions = new Map();
  root.provide('agents', { list: () => [...agents.values()], get: (id) => agents.get(id) });
  root.provide('sessions', { get: (id) => sessions.get(id) });
  root.provide('workspaceTrust', { state: () => 'trusted', checkTarget: (r, rel, o) => builtinCheckTarget(r, rel, o) });
  // one agent: its own scope with its own tool table (a duplicate name throws, as in DSH)
  const makeAgent = (id) => {
    const tools = new Map();
    const fiber = root.isolate('tools').plugin({ name: `agent-${id}`, apply: (c) => {
      c.provide('tools', { register: (d) => {
        if (tools.has(d.name)) throw new Error(`tool "${d.name}" is already registered in this scope`);
        tools.set(d.name, d);
        return () => { if (tools.get(d.name) === d) tools.delete(d.name); };
      } });
    } });
    const session = { id, header: { id, cwd: proj }, snapshotEvents: () => [] };
    const agent = { id, session, ctx: fiber.ctx, status: 'idle', tools };
    agents.set(id, agent); sessions.set(id, session);
    return agent;
  };
  const alive = () => fs.readdirSync(pidDir).map((f) => Number.parseInt(f, 10)).filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
  const pluginLog = () => { try { return fs.readFileSync(path.join(testTemp, 'dsh-project-config.log'), 'utf8'); } catch { return ''; } };

  const a = makeAgent('agent-a');                       // live before the plugin loads
  let fiber = root.plugin(plugin, {});
  await fiber;
  truthy('life: existing session mounted and connected', await waitFor(() => a.tools.has('mcp__life__echo')));
  const b = makeAgent('agent-b');
  await root.serial('agent/created', { agent: b, source: 'startup' });
  truthy('life: new session connected', await waitFor(() => b.tools.has('mcp__life__echo')));
  check('life: one child per session', (await waitFor(() => alive().length === 2)) && alive().length, 2);

  // deleting a session: it leaves the store, its agent stays live, no agent/disposed
  sessions.delete(b.id);
  root.emit('session/disposed', b.session);
  truthy('life: deleted session -> tools removed', await waitFor(() => !b.tools.has('mcp__life__echo')));
  check('life: deleted session -> its child exits', (await waitFor(() => alive().length === 1)) && alive().length, 1);
  check('life: other session untouched', a.tools.has('mcp__life__echo'), true);

  // unloading the plugin releases every session
  await fiber.dispose();
  check('life: unload -> tools removed', a.tools.size, 0);
  check('life: unload -> no child left', (await waitFor(() => alive().length === 0)) && alive().length, 0);
  truthy('life: unload logged', pluginLog().includes('plugin unloaded: released 1 session'));

  // reload with the same live agents: no name clash; the deleted session is skipped
  fiber = root.plugin(plugin, {});
  await fiber;
  truthy('life: reload -> connected again', await waitFor(() => a.tools.has('mcp__life__echo')));
  await new Promise((r) => setTimeout(r, 300));
  check('life: reload -> deleted session not mounted', [b.tools.size, alive().length], [0, 1]);
  check('life: reload -> no name clash', pluginLog().includes('already registered'), false);
  await fiber.dispose();
  check('life: second unload -> no child left', (await waitFor(() => alive().length === 0)) && alive().length, 0);
  for (const ag of agents.values()) await ag.ctx.fiber.dispose();
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(testTemp, { recursive: true, force: true });
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASS ${passed}`);
