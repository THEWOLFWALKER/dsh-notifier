// Stable package entry for DSH consumers.  Implementation constructors remain
// available only through the explicit ./internal export used by local tests
// and build tooling; ordinary package consumers receive the plugin contract.
export { name, inject, apply } from './index.mjs'
