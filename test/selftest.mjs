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
const { findRoot, checkTarget } = await import('../lib/workspace.js');
const { admits, applyChildRole, officialFilter, interceptTools, rosterText } = await import('../lib/features/subagents.js');
const { McpHub, resolveServerConfig } = await import('../lib/features/mcp.js');
const { mountHooks, validateHookMatchers, forwardExitCode } = await import('../lib/features/hooks.js');
const { normalizeResult, loadHandler } = await import('../lib/features/commands.js');
const { rewriteRoots, patchSkillRoots, installInstructionsMarker, MARKER } = await import('../lib/isolation.js');
const { statusText, mcpStateText } = await import('../lib/status.js');
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
  check('settings: subagents kept', r.settings.subagents.map((s) => [s.toolName, s.provider, s.agentOptions, s.maxDepth]), [['code-reviewer', 'spawn', undefined, 1]]);
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

// ---------------------------------------------------------------- agentOptions
{
  const sub = (extra) => parseSettings(`subagents:\n  - toolName: a\n    personaFile: a.md\n${extra}`);
  const kept = (text) => sub(text).settings.subagents[0]?.agentOptions;
  const why = (text) => inLang('en', () => sub(text).warnings.join('\n'));
  const whyZh = (text) => inLang('zh', () => sub(text).warnings.join('\n'));

  check('agentOptions: effort only survives', kept('    agentOptions:\n      reasoningEffort: high\n'), { reasoningEffort: 'high' });
  check('agentOptions: full set survives', kept('    agentOptions:\n      provider: p\n      model: m\n      reasoningEffort: low\n      maxTokens: 4096\n'), { provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 4096 });
  check('agentOptions: absent stays undefined', kept(''), undefined);

  // One unknown key makes the whole entry unusable rather than half-applied.
  truthy('agentOptions: unknown key rejected', why('    agentOptions:\n      reasoningEffort: high\n      bogus: 1\n').includes('unknown fields bogus'));
  truthy('agentOptions: unknown key zh', whyZh('    agentOptions:\n      reasoningEffort: high\n      bogus: 1\n').includes('未知字段 bogus'));
  truthy('agentOptions: array rejected', why('    agentOptions: [1, 2]\n').includes('must be an object'));
  truthy('agentOptions: string rejected', why('    agentOptions: nope\n').includes('must be an object'));
  truthy('agentOptions: empty object rejected', why('    agentOptions: {}\n').includes('must not be empty'));

  // DSH's own pairing check never fires for a project subagent, so this plugin owns it.
  truthy('agentOptions: provider alone rejected', why('    agentOptions:\n      provider: p\n').includes('provider and model together'));
  truthy('agentOptions: model alone rejected', why('    agentOptions:\n      model: m\n').includes('provider and model together'));
  truthy('agentOptions: pair zh', whyZh('    agentOptions:\n      model: m\n').includes('provider 与 model 必须同时给出'));

  truthy('agentOptions: empty effort rejected', why('    agentOptions:\n      reasoningEffort: ""\n').includes('reasoningEffort must be text'));
  truthy('agentOptions: numeric effort rejected', why('    agentOptions:\n      reasoningEffort: 3\n').includes('reasoningEffort must be text'));
  truthy('agentOptions: fractional maxTokens rejected', why('    agentOptions:\n      maxTokens: 1.5\n').includes('maxTokens must be a positive integer'));
  truthy('agentOptions: zero maxTokens rejected', why('    agentOptions:\n      maxTokens: 0\n').includes('maxTokens must be a positive integer'));

  // A rejected entry is skipped alone; its neighbours load.
  const both = parseSettings(`subagents:
  - toolName: good
    personaFile: g.md
    agentOptions:
      reasoningEffort: high
  - toolName: bad
    personaFile: b.md
    agentOptions: {}
  - toolName: also
    personaFile: a.md
`);
  check('agentOptions: bad entry skipped, others kept', both.settings.subagents.map((s) => s.toolName), ['good', 'also']);

  // backgroundMode is gone from DSH's Config; carrying it is now an unknown field.
  const bg = sub('    backgroundMode: one-shot\n');
  check('settings: backgroundMode no longer a field', bg.settings.subagents[0].backgroundMode, undefined);
  truthy('settings: backgroundMode reported unknown', inLang('en', () => bg.warnings.join('\n')).includes('unknown field "backgroundMode"'));

  // Every named entry reports its name, so N identical warnings stay distinguishable.
  truthy('settings: subagent unknown field names the entry', whyZh('    backgroundMode: one-shot\n').includes('subagents[0] (a)'));
  truthy('settings: command unknown field names the entry', inLang('zh', () => parseSettings('commands:\n  - name: hello\n    description: d\n    handlerFile: x.js\n    bogus: 1\n').warnings.join('\n')).includes('commands[0] (hello)'));
}
check('expand: ok', expandVars('a ${X} b', { X: '1' }), { value: 'a 1 b' });
check('expand: missing', expandVars('${X}${Y}', { X: '1' }), { missing: ['Y'] });
check('expand: plain $X untouched', expandVars('$X', { X: '1' }), { value: '$X' });
check('persona: frontmatter stripped', splitPersona('---\nname: a\ndescription: Does docs\n---\n\nBody here\n'), { body: 'Body here', description: 'Does docs' });
check('persona: no frontmatter', splitPersona('  just body  '), { body: 'just body', description: undefined });
check('persona: CRLF', splitPersona('---\r\ndescription: d\r\n---\r\nB'), { body: 'B', description: 'd' });

// ---------------------------------------------------------------- workspace
const gitRoot = mk('repo'); mk('repo', '.git');
const sub = mk('repo', 'pkg'); write(path.join(sub, '.dsh', 'settings.yml'), 'subagents: []');
const deep = mk('repo', 'pkg', 'src', 'x');
const outside = mk('outside'); write(path.join(outside, 'p.md'), 'p');
write(path.join(sub, 'inside.md'), 'i');
fs.symlinkSync(outside, path.join(sub, 'link-out'), 'junction');
check('root: settings.yml nearer', await findRoot(deep), sub);
check('root: git', await findRoot(path.join(gitRoot)), gitRoot);
check('check: inside ok', (await checkTarget(sub, 'inside.md', { type: 'file' })).ok, true);
check('check: outside via junction allowed', (await checkTarget(sub, 'link-out/p.md')).ok, true);
check('check: outside via junction keeps real path', (await checkTarget(sub, 'link-out/p.md')).realPath, fs.realpathSync.native(path.join(outside, 'p.md')));
check('check: ../ resolves against the root', (await checkTarget(sub, '../pkg/inside.md')).ok, true);
check('check: absolute path works', (await checkTarget(sub, outside)).ok, true);
check('check: missing', (await checkTarget(sub, 'nope')).code, 'NOT_FOUND');
check('check: type', (await checkTarget(sub, 'inside.md', { type: 'directory' })).code, 'WRONG_TYPE');
check('check: too large', (await checkTarget(sub, 'inside.md', { maxBytes: 0 })).code, 'TOO_LARGE');
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
  const m = { root: tmp, file: both.file, localFile: both.localFile, ok: true, warnings: [],
    subagentSpecs: S.subagents.map((entry) => ({ entry })), settings: S, origin: both.origin, hooksLocal: both.hooksLocal, removed: both.removed, stats: { runs: 0, failures: 0 } };
  const zh = inLang('zh', () => statusText(m, { logFile: 'L' })).split('\n');
  const en = inLang('en', () => statusText(m, { logFile: 'L' })).split('\n');
  check('status local: zh', zh.slice(1), [
    `配置文件：${both.file} + ${both.localFile}`,
    '子代理：a (local 覆盖), b, z (local)',
    '命令：/c1 (local 覆盖), /c2, /c9 (local)',
    'MCP：s2 (local 覆盖), s3, s4 (local)',
    'Hooks：tools/pre-execute ×3（local 1）, agent/pre-step ×1, tools/post-execute ×1（local 1）（已运行 0 次，失败 0 次）',
    '已移除（local enabled: false）：MCP s1',
    '日志：L',
  ]);
  check('status local: en', en.slice(1), [
    `Settings: ${both.file} + ${both.localFile}`,
    'Subagents: a (local override), b, z (local)',
    'Commands: /c1 (local override), /c2, /c9 (local)',
    'MCP: s2 (local override), s3, s4 (local)',
    'Hooks: tools/pre-execute ×3 (local 1), agent/pre-step ×1, tools/post-execute ×1 (local 1) (runs 0, failures 0)',
    'Removed (local enabled: false): MCP s1',
    'Log: L',
  ]);
  check('status local: en has no chinese', CJK.test(en.join('\n')), false);
  const connected = { ...m, hub: { summary: () => [{ name: 's2', status: 'connected', detail: TEXT.tools(2) }] } };
  truthy('status local: connected server marked', inLang('zh', () => statusText(connected, { logFile: 'L' })).includes('MCP s2 (local 覆盖)：✓ 已连接 — 2 个工具'));
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
  const status = inLang('en', () => statusText({ root: tmp, file: 'F', ok: true, warnings: [], subagentSpecs: [],
    settings: { subagents: [], commands: [], mcp: [entry], hooks: {} }, hub, stats: { runs: 0, failures: 0 } }, { logFile }));
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
  // a skipped server has no connection: reconnect must say so, not pretend it worked
  let skipErr;
  try { await hub.reconnect('c'); } catch (e) { skipErr = e; }
  check('hub: skipped server raises SkippedServer', [skipErr?.name, skipErr?.server, skipErr?.reason], ['SkippedServer', 'c', 'cwd: bad']);
  check('hub: skipped list', hub.skippedServers(), [{ name: 'c', reason: 'cwd: bad' }]);
  // per-server state rendering, both languages
  const root = { hub, origin: { mcp: new Map([['b', 'local']]) } };
  check('mcp state text', [inLang('zh', () => mcpStateText(root, ['b'])), inLang('en', () => mcpStateText(root, ['b']))],
    ['MCP b (local)：✓ 已连接 — 1 个工具', 'MCP b (local): ✓ connected — 1 tool']);
  // reload messages, one language at a time
  check('reload unknown part', [
    inLang('zh', () => `${TEXT.reloadUnknownPart('reconnect')}`),
    inLang('en', () => `${TEXT.reloadUnknownPart('reconnect')}`),
  ], [
    '不认识的重挂范围 reconnect\n只能写 subagents、commands、mcp（可再跟一个服务器名）或 hooks',
    'Unknown reload scope reconnect\nUse subagents, commands, mcp (optionally with one server name) or hooks',
  ]);
  // The transcript (dsh-client-ui-chat GenericCommandCard) only offers the
  // expander when the text contains a newline: a one-line result is forced into
  // a single nowrap row with an ellipsis and can never be opened. Every message
  // this command can produce has to stay multi-line.
  for (const [label, value] of [
    ['usage', TEXT.commandUsage],
    ['done', TEXT.reloadDone({ subagents: 9, commands: 0, mcp: 3, hooks: 1 })],
    ['unknown part', TEXT.reloadUnknownPart('x')],
    ['part done', TEXT.reloadPartDone('subagents', 3)],
    ['part failed', TEXT.reloadPartFailed('mcp')],
    ['stale', TEXT.reloadStale('commands')],
  ]) {
    truthy(`reload text is multi-line: ${label}`, String(value).includes('\n'));
  }
  check('reload done', [
    inLang('zh', () => `${TEXT.reloadDone({ subagents: 9, commands: 0, mcp: 3, hooks: 1 })}`),
    inLang('en', () => `${TEXT.reloadDone({ subagents: 9, commands: 0, mcp: 3, hooks: 1 })}`),
  ], [
    'reload 完成：\nsubagents 9\ncommands 0\nmcp 3\nhooks 1',
    'reload done:\nsubagents 9\ncommands 0\nmcp 3\nhooks 1',
  ]);
  check('reload partial names the section', [
    inLang('zh', () => `${TEXT.reloadPartial('mcp: 连接超时')}`),
    inLang('en', () => `${TEXT.reloadPartial('mcp: timeout')}`),
  ], ['reload 部分失败：mcp: 连接超时\n', 'reload partly failed: mcp: timeout\n']);
  check('reload one section', [
    inLang('zh', () => `${TEXT.reloadPartDone('subagents', 2)}`),
    inLang('en', () => `${TEXT.reloadPartDone('subagents', 2)}`),
  ], ['subagents 已重挂（2 项）：\n', 'subagents re-mounted (2):\n']);
  check('reload one section usage: multi-line', [
    inLang('zh', () => `${TEXT.commandUsage}`).split('\n').length,
    inLang('en', () => `${TEXT.commandUsage}`).split('\n')[0],
  ], [6, 'Usage:']);
  check('reload stale names the section', [
    inLang('zh', () => `${TEXT.reloadStale('commands')}`),
    inLang('en', () => `${TEXT.reloadStale('commands')}`),
  ], [
    '另有改动没有重挂：commands\n要用 /project-config reload 全量重挂才会生效',
    'Also changed but not re-mounted: commands\nrun /project-config reload to pick them up',
  ]);
  check('reload: en has no chinese', CJK.test(inLang('en', () => `${TEXT.reloadUnknownPart('x')} ${TEXT.reloadSettingsGone} ${TEXT.reloadMcpUnknown('a', 'b')} ${TEXT.mcpUnresponsive}`)), false);
  await hub.disposeAll();
  check('hub: disposeAll stops connections', hub.summary().map((x) => x.status), ['stopped', 'stopped', 'skipped']);

  check('mcp state: zh labels', inLang('zh', () => [`${TEXT.mcpState.retrying}`, `${TEXT.mcpState.reconnecting}`, `${TEXT.mcpRetry('X', { n: 2, max: 10 })}`, `${TEXT.tools(1)}`]),
    ['✗ 连接失败，重试中', '⟳ 连接断开，重连中', 'X（第 2/10 次重试）', '1 个工具']);
  check('mcp state: en plural', inLang('en', () => [`${TEXT.tools(0)}`, `${TEXT.tools(1)}`, `${TEXT.tools(2)}`]), ['0 tools', '1 tool', '2 tools']);
  const m = { root: tmp, file: 'F', ok: true, warnings: [], subagentSpecs: [], settings: { subagents: [], commands: [], mcp: [{ serverName: 'k' }], hooks: {} }, stats: { runs: 0, failures: 0 },
    hub: { summary: () => [{ name: 'k', status: 'retrying', detail: TEXT.mcpRetry('HTTP 401', { n: 1, max: 10 }) }] } };
  truthy('mcp state: status line en', inLang('en', () => statusText(m, { logFile: 'L' })).includes('MCP k: ✗ failed, retrying — HTTP 401 (retry 1/10)'));
  truthy('mcp state: status line zh', inLang('zh', () => statusText(m, { logFile: 'L' })).includes('MCP k：✗ 连接失败，重试中 — HTTP 401（第 1/10 次重试）'));
}

// ---------------------------------------------------------------- MCP health check: unresponsive, never dropped
{
  const { McpConnection, DEFAULT_HEALTH_CHECK_MS, UNRESPONSIVE_AFTER } = await import('../lib/features/mcp-connection.js');

  // A clock that runs the health timer by hand, so the measured delay is exact.
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  /** Advance the clock to the next timer, run it, and report how far time moved. */
  const tick = async () => {
    const t = timers.shift();
    if (t === undefined) return undefined;
    const moved = t.at - now;
    now = t.at;
    t.fn();
    await settle();
    return moved;
  };

  const fake = fakeMcp();
  fake.tools = [{ name: 'echo', inputSchema: { type: 'object' } }];
  const registered = new Map();
  const conn = new McpConnection({ serverName: 'h', transport: 'streamable-http', url: 'http://h/mcp' }, {
    ctx: {}, register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name); },
    log: quietLog, ...clock, healthCheckMs: DEFAULT_HEALTH_CHECK_MS,
    transportFactory: fake.transportFactory, clientFactory: fake.clientFactory,
  });

  check('health: defaults are 30s x 3', [DEFAULT_HEALTH_CHECK_MS, UNRESPONSIVE_AFTER], [30000, 3]);
  await conn.start();
  check('health: connected, timer armed', [conn.status().state, timers.length], ['connected', 1]);
  check('health: timer interval is 30s', timers[0].at - now, 30000);

  // Healthy server: every check answers, nothing is reported.
  fake.pingError = undefined;
  for (let i = 0; i < 5; i++) await tick();
  check('health: healthy pings keep it connected', [conn.status().state, conn.status().unresponsive], ['connected', false]);

  // Now the server goes silent: the ping times out (not a connection error).
  fake.pingError = Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' });
  const marks = [];
  for (let i = 0; i < 3; i++) {
    await tick();
    marks.push(conn.status().unresponsive);
  }

  // It still reports "connected": a silent server is not a dropped connection.
  check('health: silent server stays connected', conn.status().state, 'connected');
  check('health: tools kept while unresponsive', registered.size, 1);

  // The streak marks it on the 3rd unanswered check, not before.
  check('health: marked only on the 3rd timeout', marks, [false, false, true]);

  // One answer clears it.
  fake.pingError = undefined;
  await tick();
  check('health: a reply clears unresponsive', [conn.status().state, conn.status().unresponsive], ['connected', false]);

  // A real connection error still drops it (that is not "unresponsive").
  fake.pingError = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  fake.connectError = () => new Error('down');
  await tick();
  check('health: connection error still reconnects', conn.status().state, 'reconnecting');
  check('health: health timer cleared while reconnecting', timers.every((t) => t.at - now !== 30000), true);

  // A JSON-RPC error answer proves the server is alive.
  fake.connectError = undefined;
  fake.pingError = undefined;
  await conn.reconnect();
  const { ProtocolError } = await import('@modelcontextprotocol/client');
  fake.pingError = new ProtocolError(-32601, 'ping not supported');
  for (let i = 0; i < 4; i++) await tick();
  check('health: protocol error answer keeps it responsive', [conn.status().state, conn.status().unresponsive], ['connected', false]);
  fake.pingError = undefined;

  // dispose leaves no timer behind
  await conn.dispose();
  check('health: dispose clears the timer', [conn.status().state, timers.length], ['stopped', 0]);

  // --- hub: an unresponsive server is picked up by reconnect-all ----------
  let hubNow = 0;
  const hubTimers = [];
  const hubClock = {
    now: () => hubNow,
    setTimer: (fn, ms) => { const t = { fn, at: hubNow + ms }; hubTimers.push(t); return t; },
    clearTimer: (t) => { const i = hubTimers.indexOf(t); if (i >= 0) hubTimers.splice(i, 1); },
  };
  const fakeHub = fakeMcp();
  fakeHub.tools = [{ name: 't', inputSchema: { type: 'object' } }];
  const hub = new McpHub(quietLog, 't');
  await hub.startIn(fakeScope(), [{ serverName: 'a' }],
    async (e) => ({ config: { serverName: e.serverName, transport: 'streamable-http', url: 'http://h/' + e.serverName } }),
    { ...hubClock, transportFactory: fakeHub.transportFactory, clientFactory: fakeHub.clientFactory });

  const hubTick = async () => {
    const t = hubTimers.shift();
    if (t === undefined) return;
    hubNow = t.at;
    t.fn();
    await settle();
  };
  const sumHub = () => hub.summary().map((x) => [x.name, x.status, x.detail === undefined ? undefined : inLang('en', () => `${x.detail}`)]);

  check('hub health: connected', sumHub(), [['a', 'connected', '1 tool']]);

  fakeHub.pingError = Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' });
  for (let i = 0; i < 3; i++) await hubTick();
  check('hub health: shows unresponsive, not connected', sumHub()[0][1], 'unresponsive');
  truthy('hub health: says the tools are kept', sumHub()[0][2].includes('tools kept'));

  // reconnect-all must include it; before this it would have claimed "all up".
  check('hub health: reconnect-all takes the unresponsive server', await hub.reconnect(), ['a']);
  fakeHub.pingError = undefined;
  check('hub health: back to connected after reconnect', sumHub()[0][1], 'connected');

  // ... and once it is healthy again, reconnect-all has nothing to do.
  check('hub health: reconnect-all skips a healthy server', await hub.reconnect(), []);

  await hub.disposeAll();

  check('health: zh text', inLang('zh', () => `${TEXT.mcpState.unresponsive} — ${TEXT.mcpUnresponsive}`),
    '⚠ 无响应 — 连续 3 次检测没有回应，工具仍在（可以用 /project-config reload mcp 重连）');
  check('health: en text', inLang('en', () => `${TEXT.mcpState.unresponsive} — ${TEXT.mcpUnresponsive}`),
    '⚠ unresponsive — no reply to 3 health checks; tools kept (use /project-config reload mcp to restart it)');
  check('health: en text has no chinese', CJK.test(inLang('en', () => `${TEXT.mcpState.unresponsive} ${TEXT.mcpUnresponsive}`)), false);
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
{
  // The guard that keeps a duplicate registration from killing the host. DSH's
  // registry throws `tool "<name>" is already registered in this scope`, and the
  // loader treats that as a fatal load failure. Two sources produce duplicates:
  // our own mount racing a plugin reload, and dsh-tool-subagent re-installing
  // its per-agent tool. Both must degrade to a warning instead.
  const registered = [];
  const warnings = [];
  const log = { info() {}, warn: (m) => warnings.push(m), error() {} };
  const real = {
    register: (d) => {
      if (registered.includes(d.name)) throw new Error(`tool "${d.name}" is already registered in this scope`);
      registered.push(d.name);
      return () => { registered.splice(registered.indexOf(d.name), 1); };
    },
  };
  const t = interceptTools(real, (d, reg) => reg(d), { log, label: 'L' });
  t.register({ name: 'subagent' });
  t.register({ name: 'subagent' });          // second one must not throw
  check('intercept: duplicate name skipped, first kept', registered, ['subagent']);
  check('intercept: duplicate reported as a warning', warnings.length, 1);
  truthy('intercept: warning names the tool', warnings[0].includes('subagent'));

  // A duplicate the wrapper itself forwards into the real registry (its own
  // `seen` missed it, e.g. the name was registered before this proxy existed).
  const preUsed = { register: (d) => { throw new Error(`tool "${d.name}" is already registered in this scope`); } };
  const t2 = interceptTools(preUsed, (d, reg) => reg(d), { log, label: 'L' });
  let threw = false;
  try { t2.register({ name: 'subagent_fork' }); } catch { threw = true; }
  check('intercept: registry duplicate swallowed', threw, false);
  truthy('intercept: registry duplicate reported', warnings.length === 2 && warnings[1].includes('subagent_fork'));

  // Any other registration error still propagates: this guard is not a blanket.
  const broken = { register: () => { throw new Error('something else broke'); } };
  const t3 = interceptTools(broken, (d, reg) => reg(d), { log, label: 'L' });
  let otherThrew = '';
  try { t3.register({ name: 'x' }); } catch (error) { otherThrew = String(error?.message ?? error); }
  check('intercept: unrelated errors propagate', otherThrew, 'something else broke');

  // After a successful dispose the name is free again.
  const reReg = [];
  const reusable = {
    register: (d) => { reReg.push(d.name); return () => {}; },
  };
  const t4 = interceptTools(reusable, (d, reg) => reg(d), { log, label: 'L' });
  const d1 = t4.register({ name: 'y' });
  d1();
  t4.register({ name: 'y' });
  check('intercept: name reusable after dispose', reReg, ['y', 'y']);

  // Without a logger there is nowhere to report, so the duplicate surfaces as
  // DSH's own error rather than being silently swallowed.
  const t5 = interceptTools({ register: () => () => {} }, (d, reg) => reg(d));
  t5.register({ name: 'z' });
  let noLogger = '';
  try { t5.register({ name: 'z' }); } catch (error) { noLogger = String(error?.message ?? error); }
  truthy('intercept: no logger -> duplicate still reported', noLogger.includes('z') && noLogger.includes('already registered'));
}
truthy('roster: lists names', rosterText([{ entry: { toolName: 'doc' }, description: 'docs' }]).includes('`doc`: docs'));

// ---------------------------------------------------------------- subagent role (DSH 0.2.1)
// `tool-subagent` rejects `persona` and `toolFilter` on 0.2.1. A delegation tool is
// therefore installed WITHOUT `agentPreset`: the child joins the parent's retained
// composition (inheriting every tool and MCP client), and its role is applied on the
// child's own scope — a `deployment:persona-prefix` section plus `tools.restrict`.
{
  /** A child context fake recording what applyChildRole registers on it. */
  function fakeChild() {
    const sections = [];
    const restricts = [];
    const warnings = [];
    const ctx = {
      inject: (deps, cb) => {
        cb({
          systemPrompt: {
            getSectionOrder: (name) => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200),
            section: (s) => { sections.push(s); return () => {}; },
          },
          tools: {
            restrict: (filter) => {
              // Mirrors the real service: unknown names are rejected outright.
              for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
                if (name === 'no_such_tool') throw new Error(`tools.restrict() names unknown global tool "${name}"`);
              }
              restricts.push(filter);
              return () => {};
            },
          },
        });
        return { dispose: () => {} };
      },
    };
    return { ctx, sections, restricts, warnings };
  }
  const log = { info() {}, warn: (m) => {}, error() {} };

  // Persona + filter: both land on the child scope, with the official section name.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: 'You review code.', filter: { deny: ['write'] } }, {
      log, label: 't', isProjectName: () => false,
    });
    check('role: persona uses the official section name', c.sections.map((s) => s.name), ['deployment:persona-prefix']);
    check('role: persona uses DEPLOYMENT_PERSONA_PREFIX order (shadows the preset)',
      c.sections[0].order, 0);
    check('role: persona text is the project persona', c.sections[0].text, 'You review code.');
    check('role: toolFilter reaches tools.restrict', c.restricts, [{ deny: ['write'] }]);
  }

  // No filter: the child keeps every inherited tool.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: 'p' }, { log, label: 't', isProjectName: () => false });
    check('role: no toolFilter -> no restriction', c.restricts.length, 0);
  }

  // No persona (empty string): no section, but the filter still applies.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: '', filter: { allow: ['read'] } }, { log, label: 't', isProjectName: () => false });
    check('role: empty persona -> no section', c.sections.length, 0);
    check('role: filter still applied', c.restricts, [{ allow: ['read'] }]);
  }

  // A name this plugin owns (another project subagent) must not reach restrict:
  // that tool is registered per child by us, so the global registry rejects it.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: 'p', filter: { allow: ['read', 'code-reviewer', 'mcp__gh__issue'] } }, {
      log, label: 't', isProjectName: (n) => n === 'code-reviewer',
    });
    check('role: project names stripped from the filter', c.restricts, [{ allow: ['read', 'mcp__gh__issue'] }]);
  }

  // The per-agent delegation tools are stripped too (DSH registers them itself).
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: 'p', filter: { deny: ['subagent', 'list_subagent_models', 'pwsh'] } }, {
      log, label: 't', isProjectName: () => false,
    });
    check('role: per-agent tools stripped from the filter', c.restricts, [{ deny: ['pwsh'] }]);
  }

  // A filter that strips to nothing must not call restrict({}), which throws.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, { persona: 'p', filter: { deny: ['subagent'] } }, { log, label: 't', isProjectName: () => false });
    check('role: filter stripping to empty is skipped', c.restricts.length, 0);
  }

  // An unknown tool name is reported, not thrown: one bad name must not cost the
  // whole child its persona (the persona is registered before the filter).
  {
    const c = fakeChild();
    const warned = [];
    applyChildRole(c.ctx, { persona: 'p', filter: { allow: ['no_such_tool'] } }, {
      log: { info() {}, warn: (m) => warned.push(m), error() {} }, label: 't', isProjectName: () => false,
    });
    check('role: persona survives a bad tool name', c.sections.length, 1);
    check('role: bad tool name is logged', warned.length, 1);
    truthy('role: warning names the tool', warned[0].includes('unknown global tool'));
  }

  // Undefined spec (a child that is not a project subagent) is a no-op.
  {
    const c = fakeChild();
    applyChildRole(c.ctx, undefined, { log, label: 't', isProjectName: () => false });
    check('role: non-project child untouched', [c.sections.length, c.restricts.length], [0, 0]);
  }
}

// ---------------------------------------------------------------- MCP config + hub mirror
{
  const dirTarget = (root, rel) => checkTarget(root, rel, { type: 'directory' });
  mk('repo', 'pkg', 'tools');
  const r1 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', args: ['${A}'], env: { T: '${B}' } }, sub, dirTarget, { A: 'x', B: 'y' });
  check('mcp cfg: stdio expanded, cwd root', r1.config, { serverName: 's', transport: 'stdio', command: 'node', args: ['x'], env: { T: 'y' }, cwd: sub });
  const r2 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', cwd: 'tools' }, sub, dirTarget, {});
  check('mcp cfg: cwd resolved', r2.config.cwd, path.join(sub, 'tools'));
  const r3 = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', cwd: 'link-out' }, sub, dirTarget, {});
  check('mcp cfg: cwd outside allowed', r3.config?.cwd, fs.realpathSync.native(outside));
  const r3b = await resolveServerConfig({ serverName: 's', transport: 'stdio', command: 'node', cwd: 'nope' }, sub, dirTarget, {});
  truthy('mcp cfg: cwd missing refused', inLang('en', () => String(r3b.error)).startsWith('cwd: Path not found'));
  truthy('mcp cfg: cwd missing refused (zh)', inLang('zh', () => String(r3b.error)).startsWith('cwd：路径不存在'));
  const r4 = await resolveServerConfig({ serverName: 'w', transport: 'streamable-http', url: 'http://h/${P}', headers: { A: 'Bearer ${TOK}' } }, sub, dirTarget, {});
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
  check('status: no mount', statusText(undefined, { logFile: 'L' }).includes('.dsh/settings.yml'), true);
  const m = { root: sub, file: 'F', ok: true, warnings: ['w1'], subagentSpecs: [{ entry: { toolName: 'doc' } }],
    settings: { commands: [{ name: 'hi' }], mcp: [{ serverName: 's' }], hooks: { 'tools/pre-execute': [{}] } }, stats: { runs: 0, failures: 0 } };
  const t = statusText(m, { logFile: 'L' });
  for (const needle of ['doc', '/hi', 'MCP：s', 'tools/pre-execute ×1', '⚠ w1']) truthy(`status: ${needle}`, t.includes(needle));
  // one language at a time, including warnings stored earlier
  const parsed = parseSettings('subagents: [{ toolName: x }]\nskills: []\n');
  const m2 = { ...m, warnings: parsed.warnings, settings: { ...m.settings }, hub: { summary: () => [{ name: 's', status: 'connected', detail: TEXT.tools(3) }] } };
  const zh = inLang('zh', () => statusText(m2, { logFile: 'L' }));
  const en = inLang('en', () => statusText(m2, { logFile: 'L' }));
  check('status: zh lines', zh.split('\n').slice(0, 2), [`工作区：${sub}`, '配置文件：F']);
  check('status: en lines', en.split('\n').slice(0, 2), [`Workspace: ${sub}`, 'Settings: F']);
  truthy('status: zh mcp', zh.includes('MCP s：✓ 已连接 — 3 个工具'));
  truthy('status: en mcp', en.includes('MCP s: ✓ connected — 3 tools'));
  check('status: en has no chinese', CJK.test(en), false);
  // config keys such as `tools/pre-execute` stay as written
  check('status: zh has no english sentences', /\b(Workspace|Settings|Subagents|Commands|connected|tools|skipped|ignored|must)\b/.test(zh.replace(/[a-z]+\/[a-z-]+/g, '')), false);
  // a nested message built while zh is active, shown later in en (and back)
  const nested = inLang('zh', () => TEXT.cwdProblem(TEXT.notFound('X')));
  check('status: nested message follows language', [inLang('en', () => `${nested}`), inLang('zh', () => `${nested}`)],
    ['cwd: Path not found: X', 'cwd：路径不存在：X']);
  check('status: no-mount text per language', [inLang('zh', () => statusText(undefined, { logFile: 'L' })).startsWith('此会话'), inLang('en', () => statusText(undefined, { logFile: 'L' })).startsWith('No project')], [true, true]);
  // path messages per language
  const missingZh = await checkTarget(sub, 'nope');
  check('path: message per language', [inLang('zh', () => `${missingZh.message}`), inLang('en', () => `${missingZh.message}`)], ['路径不存在：nope', 'Path not found: nope']);
  const wrong = await checkTarget(sub, 'inside.md', { type: 'directory' });
  check('path: type per language', [inLang('zh', () => `${wrong.message}`), inLang('en', () => `${wrong.message}`)], ['路径类型不符：inside.md', 'Wrong path type: inside.md']);
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

// ---------------------------------------------------------------- /project-config reload (real Cordis, real MCP child, real subagent tools)
{
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const plugin = await import('../lib/index.js');
  const proj = mk('reload');
  const pidDir = mk('reload-pids');
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
  write(path.join(proj, 'a.md'), '---\ndescription: role A\n---\nYou are A.');
  write(path.join(proj, 'b.md'), '---\ndescription: role B\n---\nYou are B.');
  write(path.join(proj, 'cmd.mjs'), 'export default () => "ok";');
  const settingsOf = (subagents, commands = '', hooks = '') => [
    'mcp:',
    '  - serverName: life',
    '    transport: stdio',
    `    command: '${process.execPath.replace(/\\/g, '/')}'`,
    '    args: [server.mjs]',
    `    env: { PID_DIR: '${pidDir.replace(/\\/g, '/')}' }`,
    subagents,
    commands,
    hooks,
  ].filter(Boolean).join('\n');
  const oneSub = (name, file) => `subagents:\n  - toolName: ${name}\n    personaFile: ${file}\n`;
  const twoSubs = `${oneSub('alpha', 'a.md')}  - toolName: beta\n    personaFile: b.md\n`;
  const settingsFile = path.join(proj, '.dsh', 'settings.yml');
  write(settingsFile, settingsOf(oneSub('alpha', 'a.md')));

  const root = new Context();
  const agents = new Map();
  const sessions = new Map();
  root.provide('agents', { list: () => [...agents.values()], get: (id) => agents.get(id) });
  root.provide('sessions', { get: (id) => sessions.get(id) });
  // The plugin registers `/project-config` through `ctx.commands`; this stands in
  // for dsh-commands so the test can call the handler the UI would call.
  const registered = new Map();
  root.provide('commands', {
    register: (definition) => {
      registered.set(definition.name, definition);
      return () => { if (registered.get(definition.name) === definition) registered.delete(definition.name); };
    },
  });

  // The real `systemPrompt` and `commands` are cordis services: `this.ctx` inside
  // them is the *calling* ctx (the tracker proxy rebinds it), so `c.effect(...)`
  // registers against the caller's fiber and a duplicate name throws. A plain
  // `provide()` object would be a stricter fake: it would survive the caller's
  // disposal, which is not what DSH does. These subclasses reproduce the real
  // lifetime — that is what makes the reload tests meaningful.
  class FakePrompt extends Service {
    constructor(ctx) {
      super(ctx, 'systemPrompt')
      this.sections = new Set()
    }
    section(s) {
      if (this.sections.has(s.name)) throw new Error(`prompt section "${s.name}" is already registered in this scope`)
      return this.ctx.effect(() => {
        this.sections.add(s.name)
        return () => this.sections.delete(s.name)
      }, `section ${s.name}`)
    }
    context() {
      return () => {}
    }
    getSectionOrder() {
      return 2800
    }
    getContextOrder() {
      return 0
    }
  }
  class FakeCommands extends Service {
    constructor(ctx) {
      super(ctx, 'commands')
      this.entries = new Map()
    }
    register(definition) {
      if (this.entries.has(definition.name)) throw new Error(`command "${definition.name}" is already registered in this scope`)
      return this.ctx.effect(() => {
        this.entries.set(definition.name, definition)
        return () => { if (this.entries.get(definition.name) === definition) this.entries.delete(definition.name) }
      }, `command ${definition.name}`)
    }
  }

  // An agent scope that satisfies what mountSubagentTools injects: tools,
  // subagents, systemPrompt, sessionProjections. The `subagents` provider is the
  // minimum dsh-tool-subagent's apply() needs (presets unconfigured, provider present).
  const makeAgent = (id, header = {}) => {
    const tools = new Map();
    const fiber = root
      .isolate('tools')
      .isolate('systemPrompt')
      .isolate('subagents')
      .isolate('sessionProjections')
      .isolate('commands')
      .plugin({
        name: `agent-${id}`,
        apply: (c) => {
          c.provide('tools', {
            register: (d) => {
              if (tools.has(d.name)) throw new Error(`tool "${d.name}" is already registered in this scope`);
              tools.set(d.name, d);
              return () => { if (tools.get(d.name) === d) tools.delete(d.name); };
            },
            get: (name) => tools.get(name),
          });
          new FakePrompt(c);
          new FakeCommands(c);
          c.provide('subagents', {
            getProvider: () => ({ name: 'fake', capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: false }),
            resolveMaxDepth: () => undefined,
          });
          c.provide('sessionProjections', { register: () => () => {} });
        },
      });
    const session = { id, header: { id, cwd: proj, ...header }, snapshotEvents: () => [] };
    const agent = { id, session, ctx: fiber.ctx, tools, commands: () => fiber.ctx.get('commands')?.entries ?? new Map() };
    agents.set(id, agent); sessions.set(id, session);
    return agent;
  };
  const alive = () => fs.readdirSync(pidDir).map((f) => Number.parseInt(f, 10)).filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
  const pluginLog = () => { try { return fs.readFileSync(path.join(testTemp, 'dsh-project-config.log'), 'utf8'); } catch { return ''; } };

  const a = makeAgent('reload-a');
  let fiber = root.plugin(plugin, {});
  await fiber;
  const run = async (input, agent = a) => {
    const definition = registered.get('project-config');
    if (definition === undefined) throw new Error('/project-config was not registered');
    return definition.handler({ agent, rawInput: input });
  };

  truthy('reload: initial subagent mounted', await waitFor(() => a.tools.has('alpha')));
  truthy('reload: initial mcp connected', await waitFor(() => a.tools.has('mcp__life__echo')));
  check('reload: one mcp child', alive().length, 1);
  const firstPid = alive()[0];

  // --- full reload: settings change is picked up, nothing crashes --------------
  write(settingsFile, settingsOf(twoSubs, 'commands:\n  - name: hi\n    description: d\n    handlerFile: cmd.mjs\n', 'hooks:\n  tools/pre-execute:\n    - { command: node x.mjs }\n'));
  let out = await run('reload');
  check('reload: full -> success', out.kind, 'success');
  truthy('reload: full reports the new subagent', out.text.includes('subagents 2'));
  truthy('reload: full mounted the new subagent', await waitFor(() => a.tools.has('beta')));
  truthy('reload: full reconnected mcp', await waitFor(() => a.tools.has('mcp__life__echo')));
  truthy('reload: full mounted the command', await waitFor(() => a.commands().has('hi')));
  check('reload: old mcp child replaced', (await waitFor(() => alive().length === 1)) && alive()[0] !== firstPid, true);

  // twice in a row: releaseRoot has to be complete or the second mount throws
  const beforeLog = pluginLog().length;
  out = await run('reload');
  check('reload: second full reload succeeds', out.kind, 'success');
  check('reload: no duplicate registration', pluginLog().slice(beforeLog).includes('already registered'), false);
  truthy('reload: subagents still mounted after two reloads', a.tools.has('alpha') && a.tools.has('beta'));

  // --- single sections --------------------------------------------------------
  // subagents only: a removed entry disappears, other sections stay
  write(settingsFile, settingsOf(oneSub('alpha', 'a.md'), 'commands:\n  - name: hi\n    description: d\n    handlerFile: cmd.mjs\n', 'hooks:\n  tools/pre-execute:\n    - { command: node x.mjs }\n'));
  truthy('reload subagents: mcp back before the run', await waitFor(() => a.tools.has('mcp__life__echo')));
  out = await run('reload subagents');
  check('reload subagents: success', out.kind, 'success');
  truthy('reload subagents: names the tools', out.text.includes('alpha') && !out.text.includes('beta'));
  check('reload subagents: removed tool gone', a.tools.has('beta'), false);
  truthy('reload subagents: kept tool still there', a.tools.has('alpha'));
  truthy('reload subagents: mcp untouched', a.tools.has('mcp__life__echo'));
  truthy('reload subagents: command untouched', a.commands().has('hi'));

  // commands only: the handler is registered again under the same name
  write(settingsFile, settingsOf(oneSub('alpha', 'a.md'), 'commands:\n  - name: hi\n    description: d\n    handlerFile: cmd.mjs\n  - name: bye\n    description: d\n    handlerFile: cmd.mjs\n', 'hooks:\n  tools/pre-execute:\n    - { command: node x.mjs }\n'));
  out = await run('reload commands');
  check('reload commands: success', out.kind, 'success');
  truthy('reload commands: reports both', out.text.includes('/hi') && out.text.includes('/bye'));
  truthy('reload commands: new command registered', await waitFor(() => a.commands().has('bye')));
  truthy('reload commands: subagent untouched', a.tools.has('alpha'));

  // hooks only: kept as one section, and the status counts it
  out = await run('reload hooks');
  check('reload hooks: success', out.kind, 'success');
  truthy('reload hooks: names the event', out.text.includes('tools/pre-execute'));

  // mcp only: the child process is replaced, the rest is untouched
  const pidBeforeMcp = alive()[0];
  out = await run('reload mcp');
  check('reload mcp: success', out.kind, 'success');
  truthy('reload mcp: reports the server', out.text.includes('life'));
  truthy('reload mcp: reconnected', await waitFor(() => a.tools.has('mcp__life__echo')));
  check('reload mcp: child replaced', (await waitFor(() => alive().length === 1)) && alive()[0] !== pidBeforeMcp, true);
  truthy('reload mcp: subagent untouched', a.tools.has('alpha'));
  truthy('reload mcp: command untouched', a.commands().has('bye'));

  // one named server
  const pidBeforeNamed = alive()[0];
  out = await run('reload mcp life');
  check('reload mcp <name>: success', out.kind, 'success');
  truthy('reload mcp <name>: reconnected', await waitFor(() => a.tools.has('mcp__life__echo')));
  check('reload mcp <name>: child replaced', (await waitFor(() => alive().length === 1)) && alive()[0] !== pidBeforeNamed, true);

  // --- mcp added after the session was mounted -------------------------------
  // The mount happened while settings.yml had no `mcp` section, so there is no
  // hub; naming a server must bring the whole section up rather than report that
  // nothing is mounted.
  {
    const lateDir = mk('reload-late');
    const latePid = mk('reload-late-pids');
    write(path.join(lateDir, 'server.mjs'), fs.readFileSync(path.join(proj, 'server.mjs')));
    const lateSettings = path.join(lateDir, '.dsh', 'settings.yml');
    write(lateSettings, 'subagents: []\n');
    const late = makeAgent('reload-late', { cwd: lateDir });
    await root.serial('agent/created', { agent: late, source: 'startup' });
    await waitFor(() => agents.has('reload-late'));
    const lateRun = async (input) => {
      const definition = registered.get('project-config');
      return definition.handler({ agent: late, rawInput: input });
    };
    check('reload late mcp: no hub yet', late.tools.size > 0 ? late.tools.has('mcp__life__echo') : false, false);
    write(lateSettings, `mcp:\n  - serverName: life\n    transport: stdio\n    command: '${process.execPath.replace(/\\/g, '/')}'\n    args: [server.mjs]\n    env: { PID_DIR: '${latePid.replace(/\\/g, '/')}' }\n`);
    const r = await lateRun('reload mcp life');
    check('reload late mcp: succeeds', r.kind, 'success');
    truthy('reload late mcp: server is up', await waitFor(() => late.tools.has('mcp__life__echo')));
  }

  out = await run('reload mcp nope');
  check('reload mcp unknown: error', out.kind, 'error');
  truthy('reload mcp unknown: names it and lists the rest', out.text.includes('nope') && out.text.includes('life'));

  // --- argument validation ----------------------------------------------------
  for (const [input, needle] of [
    ['reconnect', '不认识的参数 reconnect'],
    ['reload reconnect', '不认识的重挂范围 reconnect'],
    ['reload mcp a b', '用法'],
    ['reload x', '不认识的重挂范围 x'],
    ['reload mcp a b c', '用法'],
  ]) {
    const r = await run(input);
    check(`reload args: ${input} -> error`, r.kind, 'error');
    truthy(`reload args: ${input} -> names the problem (${needle})`, r.text.includes(needle));
    truthy(`reload args: ${input} -> multi-line`, r.text.includes('\n'));
  }

  // --- a running subagent session survives a full reload ----------------------
  const child = makeAgent('reload-child', { origin: 'subagent', parentSession: 'reload-a', delegationDepth: 1 });
  await root.serial('agent/created', { agent: child, source: 'subagent' });
  truthy('reload child: mirror mounted', await waitFor(() => child.tools.has('mcp__life__echo')));
  // maxDepth defaults to 1, so a depth-1 child gets no project subagents of its
  // own: only the mirror and hooks are on its scope.
  const childToolsBefore = [...child.tools.keys()].sort();
  out = await run('reload');
  check('reload child: full reload succeeds', out.kind, 'success');
  truthy('reload child: still has the mcp tool', await waitFor(() => child.tools.has('mcp__life__echo')));
  check('reload child: tool set restored', [...child.tools.keys()].sort(), childToolsBefore);

  // --- broken settings: reported, the running mount is left alone -------------
  write(settingsFile, 'not: [valid: yaml\n');
  out = await run('reload subagents');
  check('reload: broken yaml -> error', out.kind, 'error');
  truthy('reload: broken yaml -> says why', out.text.includes('YAML') || out.text.includes('yaml') || out.text.includes('settings'));
  truthy('reload: broken yaml -> old subagents still mounted', a.tools.has('alpha'));

  // --- no settings any more ---------------------------------------------------
  fs.rmSync(settingsFile);
  out = await run('reload');
  check('reload: settings gone -> reported', out.kind, 'success');
  truthy('reload: settings gone -> says so', out.text.includes('settings.yml'));

  await fiber.dispose();
  check('reload: unload -> no child left', (await waitFor(() => alive().length === 0)) && alive().length, 0);
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
