// v0.13: diagnostics must never echo configured secret values.
import { maskSecrets } from '../redact.mjs'

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

export function diagnosticErrorMessage(error, ...sources) {
  const message = error instanceof Error ? error.message : String(error)
  return redactDiagnostic(message, ...sources)
}

