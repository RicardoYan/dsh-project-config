// Self-test for dsh-project-config. Run with DSH's bundled node:
//   node test/selftest.mjs
// Official packages are resolved from DSH_PACKAGES (default: the DSH install's
// extracted node_modules), so the repository needs no node_modules of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

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

const { parseSettings, expandVars, splitPersona, loadSettings } = await import('../lib/settings.js');
const { builtinFindRoot, builtinCheckTarget, createWorkspace } = await import('../lib/workspace.js');
const { admits, officialFilter, interceptTools, rosterText } = await import('../lib/features/subagents.js');
const { McpHub, resolveServerConfig } = await import('../lib/features/mcp.js');
const { mountHooks, validateHookMatchers, forwardExitCode } = await import('../lib/features/hooks.js');
const { normalizeResult, loadHandler } = await import('../lib/features/commands.js');
const { rewriteRoots, patchSkillRoots, installInstructionsMarker, MARKER } = await import('../lib/isolation.js');
const { statusText } = await import('../lib/status.js');
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

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASS ${passed}`);
