// v0.13 secret-field update contract.
// Omitted/blank values mean keep; a non-empty value replaces; an explicit
// clear list is the only way to delete a secret field through a patch.

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null

/**
 * Split transport-only clear controls from a field patch.
 * Both names are accepted so HTTP clients can use the descriptive
 * `clearSecrets`, while lower-level callers can use the shorter `clear`.
 * @param {unknown} value
 * @returns {{ patch: object|null, clear: string[] }}
 */
export function splitSecretPatch(value) {
  const obj = plain(value)
  if (obj === null) return { patch: obj, clear: [] }
  const clear = []
  for (const name of ['clear', 'clearSecrets']) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) continue
    if (!Array.isArray(obj[name]) || obj[name].some((key) => typeof key !== 'string' || key.trim() === '')) {
      throw Object.assign(new Error(`${name} 必须是非空字符串数组`), { code: 'bad-request' })
    }
    clear.push(...obj[name].map((key) => key.trim()))
  }
  const patch = { ...obj }
  delete patch.clear
  delete patch.clearSecrets
  return { patch, clear: [...new Set(clear)] }
}

