// v0.15 Stage S19 (T28) — user-lifecycle documentation is real, not decorative.
//
// Acceptance L01 (04-ACCEPTANCE-AND-REVIEW.md): the full journey (install → upgrade → swap
// machine → uninstall) must be covered, and every command path the docs hand the user must
// actually exist. Real-device / real-provider journey evidence stays out of the hermetic CI
// boundary (declared in the doc itself) — this suite guards the parts CI *can* prove:
//   * every `node scripts/*.mjs` the lifecycle doc tells a user to run exists and parses;
//   * every `npm run <script>` it names is a real package script;
//   * every relative doc link resolves to a tracked file;
//   * the nine journeys and the two load-bearing claims (no secrets in export / external
//     references are re-bound, not migrated) are actually present.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = join(ROOT, 'docs', 'user-lifecycle.md')
const doc = readFileSync(DOC_PATH, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const scriptsReferenced = [...new Set([...doc.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]))]
const npmScriptsReferenced = [...new Set([...doc.matchAll(/npm run ([\w:]+)/g)].map((m) => m[1]))]
const relativeLinks = [...new Set([...doc.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)].map((m) => m[1]))]

test('L01: every `node scripts/*.mjs` named in the lifecycle doc exists and parses', () => {
  assert.equal(scriptsReferenced.length >= 4, true, 'the doc names real scripts')
  for (const rel of scriptsReferenced) {
    const abs = join(ROOT, rel)
    assert.equal(existsSync(abs), true, `${rel} must exist`)
    // Real syntax check (no execution): a doc pointing at a broken script is worse than no doc.
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' })
  }
})

test('L01: every `npm run <script>` named in the lifecycle doc is a real package script', () => {
  assert.equal(npmScriptsReferenced.length >= 1, true)
  for (const name of npmScriptsReferenced) {
    assert.equal(typeof pkg.scripts?.[name], 'string', `npm run ${name} must be a real script`)
  }
})

test('L01: every relative link in the lifecycle doc resolves to a real file', () => {
  assert.equal(relativeLinks.length >= 5, true, 'the doc links into the rest of docs/')
  for (const link of relativeLinks) {
    const target = link.split('#')[0]
    assert.equal(existsSync(join(ROOT, 'docs', target)), true, `link target docs/${target} must exist`)
  }
})

test('L01: the doc covers the nine journeys of the full user lifecycle', () => {
  const journeys = [
    '## 1. 安装',
    '## 2. 首次保存',
    '## 3. 复用 / 迁移',
    '## 4. 日常问题 / 审批',
    '## 5. 手机入口',
    '## 6. 断线 / 健康',
    '## 7. 升级',
    '## 8. 导出换机',
    '## 9. 停用 / 卸载',
  ]
  for (const heading of journeys) {
    assert.equal(doc.includes(heading), true, `missing journey section: ${heading}`)
  }
})

test('L01: the two load-bearing migration claims are stated explicitly', () => {
  assert.match(doc, /导出仅?不含|永不含/, 'export carries no secret must be stated')
  assert.match(doc, /重绑外部引用|外部（机器特定）引用不会被导入重绑/, 'external references are re-bound, not migrated')
  assert.match(doc, /新渠道默认 `?disabled`?/, 'imported channels land disabled')
  assert.match(doc, /Native「通知与控制」|Native 「通知与控制」/, 'screenshots/tutorial claim Native, not the legacy console')
})