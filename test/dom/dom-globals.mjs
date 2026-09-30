// Installs a jsdom window/document as Node globals. MUST be evaluated before
// react-dom is imported: react-dom freezes its browser detection (`canUseDOM`,
// input-event support) at module-evaluation time.
import { JSDOM } from 'jsdom'

let current = null

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

/** (Re)install jsdom as the global DOM environment. Safe to call before each test. */
export function installDomEnvironment({ url = 'https://dsh.local/' } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { url, pretendToBeVisual: true },
  )
  defineGlobal('window', dom.window)
  defineGlobal('document', dom.window.document)
  defineGlobal('HTMLElement', dom.window.HTMLElement)
  defineGlobal('HTMLInputElement', dom.window.HTMLInputElement)
  defineGlobal('Event', dom.window.Event)
  defineGlobal('MouseEvent', dom.window.MouseEvent)
  defineGlobal('KeyboardEvent', dom.window.KeyboardEvent)
  defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  current = dom
  return dom
}

/** The active jsdom instance. */
export function getDom() {
  return current
}

installDomEnvironment()