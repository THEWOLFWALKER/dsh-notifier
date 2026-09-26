// v0.13: diagnostics must never echo configured secret values.
import { maskSecrets } from '../redact.mjs'

const SECRET_KEY = /(?:token|secret|password|credential|authorization|cookie|webhook|appkey|appsecret|sendkey|sctkey|accesskey|privatekey|api[-_]?key|chatid|userid|accountid|headers?|^key$)/i

function stringsOf(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, output)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringsOf(item, output)
  }
  return output
}

export function redactDiagnostic(message, ...sources) {
  let output = maskSecrets(String(message ?? ''))
  const values = sources.flatMap((source) => stringsOf(source)).filter((value) => value.length > 0)
  for (const value of values) output = output.split(value).join('***')
  return maskSecrets(output)
}

export function redactDiagnosticValue(value, ...sources) {
  const visit = (item, key = '') => {
    if (SECRET_KEY.test(key)) return '***'
    if (typeof item === 'string') return redactDiagnostic(item, ...sources)
    if (Array.isArray(item)) return item.map((entry) => visit(entry))
    if (item !== null && typeof item === 'object') {
      const out = {}
      for (const [childKey, child] of Object.entries(item)) out[childKey] = visit(child, childKey)
      return out
    }
    return item
  }
  return visit(value)
}

export function diagnosticErrorMessage(error, ...sources) {
  const message = error instanceof Error ? error.message : String(error)
  return redactDiagnostic(message, ...sources)
}
