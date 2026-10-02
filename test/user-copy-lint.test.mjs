// User-copy lint (Stage 1 / S5).
//
// The user must never see implementation thinking. This test captures the ACTUAL
// zh / en dictionaries the client registers with the host locale service and
// fails if any *visible* string contains vocabulary from the copy gate
// (05_USER_COPY_GATE.md). Code comments, docs/developer/** and the platform's own
// field names are exempt by design — the dictionary is where user-visible copy lives.
//
// It also lints the server-side user-word table (src/native/vocabulary.mjs), since
// those strings are projected straight into the same dictionaries at runtime.

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readdirSync, readFileSync } from 'node:fs'

/** Internal words the user must never read (05_USER_COPY_GATE.md). */
const FORBIDDEN_EN = [
  'configured', 'runtime', 'epoch', 'revision', 'claim', 'settle', 'binding',
  'principal', 'control plane', 'rpc', 'projection', 'authority', 'ledger',
  'state machine', 'durable', 'fail-closed', 'transaction', 'rmw', 'd1',
  'webhook', 'provider evidence',
]
const FORBIDDEN_ZH = [
  '运行时', '世代', '修订号', '占位', '终态', '账本', '投影', '权威源',
  '控制面', '事务', '持久化结论', '接线', '适配层',
]

/** Platform-official field names the user genuinely has to copy verbatim. */
const ALLOW = [
  'App ID', 'App Secret', 'Bot Token', 'CorpID', 'AgentId',
]

function stripAllow(text) {
  let out = text
  for (const allowed of ALLOW) out = out.split(allowed).join(' ')
  return out
}

/**
 * 去掉注释后再扫引号串。
 *
 * 为什么需要：vocabulary.mjs 的**注释**会引用被禁词作为反例说明红线（例如
 * 「`webhook` 不是用户词」）。注释不是用户词表，不应被当作违规；但注释里的引号
 * 同样会命中朴素的引号正则。这里做字符串感知的注释剥离——只跳过真正的注释，
 * 字符串字面量里的 `//`（URL）不会被误伤，代码里的标识符仍照常受检。
 */
function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

function loadDictionaries() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const noop = () => {}
  const fakeReact = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged, children }
    },
    Component: class { constructor(props) { this.props = props; this.state = {} } setState() {} },
    useCallback: (fn) => fn,
    useEffect: noop,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, noop],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } }, open() { return null } },
    document: {
      visibilityState: 'visible',
      addEventListener() {}, removeEventListener() {},
      head: { appendChild() {} },
      createElement() { return { dataset: {}, textContent: '', remove() {} } },
    },
    setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout, AbortController, console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const mod = registration.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require ${name}`)
  })

  let captured = null
  const disposers = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    locale: {
      register(_ns, dicts) { captured = dicts; return () => {} },
      bind() { return (key) => key },
      subscribe() { return () => {} },
      resolveText: (value) => (typeof value === 'string' ? value : (value?.en ?? '')),
    },
    layout: { selectPanel() {} },
    connection: { rpc: { async call() { return { ok: true, value: { revision: 0 } } } } },
    slots: { inject(_name, fn) { return fn() }, register() { return () => {} } },
  }
  try {
    mod.apply(ctx)
  } finally {
    for (const dispose of disposers.reverse()) { try { dispose() } catch { /* best effort */ } }
  }
  assert.ok(captured && captured.zh && captured.en, 'the client registers a zh/en dictionary')
  return captured
}

function visibleStrings(dict) {
  return Object.entries(dict).filter(([, value]) => typeof value === 'string')
}

const dictionaries = loadDictionaries()

test('user copy lint — the visible client dictionary never names internals', () => {
  const offenders = []
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of visibleStrings(dictionaries[lang])) {
      const text = stripAllow(value)
      const haystack = lang === 'en' ? text.toLowerCase() : text
      for (const word of (lang === 'en' ? FORBIDDEN_EN : FORBIDDEN_ZH)) {
        const hit = lang === 'en'
          ? new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)
          : haystack.includes(word)
        if (hit) offenders.push(`${lang}.${key}: "${value}" (${word})`)
      }
    }
  }
  assert.deepEqual(offenders, [], `visible copy must stay in user words:\n${offenders.join('\n')}`)
})

/** User-facing prose the gate also covers: the two READMEs and every docs/user page. */
function userDocFiles() {
  const files = ['README.md', 'README.zh-CN.md']
  const userDir = new URL('../docs/user/', import.meta.url)
  for (const entry of readdirSync(userDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(`docs/user/${entry.name}`)
  }
  return files
}

/**
 * 只扫可见散文：围栏代码块与行内 `code` 是命令/字段样例，不是写给用户读的文案，
 * 剥掉它们避免把 `--profile`、JSON 键之类的合法技术片段误判成违规词。
 */
function stripMarkdown(source) {
  return source.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

function findForbidden(text) {
  const allowed = stripAllow(text)
  const hits = []
  const lower = allowed.toLowerCase()
  for (const word of FORBIDDEN_EN) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) hits.push(word)
  }
  for (const word of FORBIDDEN_ZH) if (allowed.includes(word)) hits.push(word)
  return hits
}

test('user copy lint — README and user docs never name internals', () => {
  const offenders = []
  for (const file of userDocFiles()) {
    const text = stripMarkdown(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    for (const word of findForbidden(text)) offenders.push(`${file} (${word})`)
  }
  assert.deepEqual(offenders, [], `user docs must stay in user words:\n${offenders.join('\n')}`)
})

test('user copy lint — the server-side user-word table stays in user words', () => {
  const source = readFileSync(new URL('../src/native/vocabulary.mjs', import.meta.url), 'utf8')
  const strings = [...stripComments(source).matchAll(/['"`]([^'"`\n]+)['"`]/g)].map((match) => match[1])
  const offenders = []
  for (const value of strings) {
    const text = stripAllow(value)
    const lower = text.toLowerCase()
    for (const word of FORBIDDEN_EN) {
      if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) offenders.push(`"${value}" (${word})`)
    }
    for (const word of FORBIDDEN_ZH) if (text.includes(word)) offenders.push(`"${value}" (${word})`)
  }
  assert.deepEqual(offenders, [], `projected user words must stay in user words:\n${offenders.join('\n')}`)
})