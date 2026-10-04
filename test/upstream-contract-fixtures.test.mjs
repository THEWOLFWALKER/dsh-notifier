// Contract fixtures are pinned to upstream source bytes, never inferred from local mocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const sha256 = value => createHash('sha256').update(value).digest('hex')

test('DSH Host pinned rpc-host fixture defines operator admission as peer or rejection', () => {
  const source = read('../docs/developer/rebuild-v015/sources/upstream-rpc-host.ts')
  assert.equal(sha256(source), 'bf305c21998f65d605c22ca01646a7ce277ea4e298cc34abaf13832f789f01c3')
  assert.match(source, /admit\(request: ConnectionTrustRequest\): PeerAdmission/)
  assert.match(source, /return rejection === undefined \? \{ peer: this\.operator \} : \{ rejection \}/)
})

test('dsh-im pinned delivery fixture defines nested account fingerprint and checked-send arguments', () => {
  const source = read('../docs/developer/rebuild-v015/sources/upstream-delivery-service.mjs')
  assert.equal(sha256(source), '5feb0364997ef27c666947c507e3d75728212e37205c7ee3ba77ccb31d478440')
  assert.match(source, /account\.account\?\.fingerprint !== expectedFingerprint/)
  assert.match(source, /async sendChecked\(botId, targetId, text, \{ expectedFingerprint, expectedTargetDigest, signal, format = 'plain' \} = \{\}\)/)
  assert.match(source, /return \{ sent: true \}/)
})

test('dsh-im pinned adapter fixture defines legal private and group targets', () => {
  const source = read('../docs/developer/rebuild-v015/sources/upstream-delivery-adapter.mjs')
  assert.equal(sha256(source), 'a2140e080a58a3b798f88b9e7eb05ff26e6f4b82e04d6954fd2feb88bed3070f')
  assert.match(source, /case 'feishu':[\s\S]*oneOf\(kind, \['user', 'group'\]\)[\s\S]*kind === 'user' \? \['openId'\] : \['chatId'\]/)
})

test('dsh-im client panel fixture is a React embedding surface, not a config import API', () => {
  const source = read('../docs/developer/rebuild-v015/sources/upstream-client-integration.md')
  assert.equal(sha256(source), 'a32d108a5c6c0b73aeed46a547d43c20d7ee31616e51a2786dd0cc7902a29908')
  assert.match(source, /interface DshImClient[\s\S]*readonly version: 1;[\s\S]*render\(props\?: \{ preferredSectionId\?: string \}\): React\.ReactElement \| null;[\s\S]*setSettingsVisible\(visible: boolean\): void;[\s\S]*settingsVisible\(\): boolean;/)
  assert.doesNotMatch(source, /importConfig|exportConfig|readConfig|writeConfig/)
})
