import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(sourceDirectory, '../..')
const outputPath = resolve(packageRoot, 'lib/client.js')
const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
})
const bundled = result.outputFiles?.[0]?.text
if (!bundled) throw new Error('esbuild did not produce a client bundle')
const wrapped = `window.__ModuleLoader__.load({\n  id: 'dsh-notifier',\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${bundled}\n    return module.exports;\n  }\n});\n`
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped, 'utf8')
console.log(`Wrote ${outputPath}`)