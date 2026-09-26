// v0.13 default-test boundary: provider/network access is opt-in.
// Local HTTP integration tests may still use loopback; all other destinations
// must be explicitly enabled with DSH_REAL_PROVIDER_TESTS=1.

export const REAL_PROVIDER_TESTS = process.env.DSH_REAL_PROVIDER_TESTS === '1'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(String(input))
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return new URL(input.url)
  return null
}

function isLoopback(url) {
  return url !== null
    && (url.protocol === 'http:' || url.protocol === 'https:')
    && LOOPBACK_HOSTS.has(url.hostname)
}

if (!REAL_PROVIDER_TESTS) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    if (isLoopback(url)) return realFetch(input, init)
    const rendered = url?.href ?? '<unparseable request>'
    throw new Error(
      `default test suite blocked external network: ${rendered}; `
      + 'set DSH_REAL_PROVIDER_TESTS=1 only for explicit provider evidence',
    )
  }
}

