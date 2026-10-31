# Guard: never touch the real DSH profile

The real DSH home (`~/.dsh`) belongs to the maintainer and is OUT OF BOUNDS for
every test in this repo. Only throwaway homes under
`/home/orca/work/dsh-notifier-rc5/scratch/` (`dshhome-*`) may be created,
written, or deleted.

`harness.mjs` enforces this: `assertNotRealDshHome(p)` throws when any target
resolves to `~/.dsh` (or anything inside it), and `assertInsideScratch(p)`
throws when a path escapes the scratch root — every mutating helper calls both.

```js
// Optional standalone check, usable anywhere:
import { assertNotRealDshHome, REAL_DSH_HOME } from './harness.mjs'
import { join } from 'node:path'
try {
  assertNotRealDshHome(join(process.env.HOME, '.dsh')) // throws: real home
  throw new Error('guard failed: real ~/.dsh was not refused')
} catch (e) {
  if (!/real DSH home/.test(String(e))) throw e // expected refusal
}
```
