// Real-React DOM harness for dsh-notifier client.js.
//
// Why this exists: test/client-module.test.mjs loads client.js in a hand-written
// fakeReact shim, which cannot observe focus, caret, real effects, downloads or
// layout. U01–U14 require a REAL React DOM render. This harness reproduces the
// exact DSH host loading contract — an IIFE calling
// `window.__ModuleLoader__.load({ id, factory })` whose factory `require('react')`
// — but injects the real `react` package and mounts into a jsdom document.
//
// It is deliberately isolated under test/dom so the core `npm install` stays
// dependency-free.
//
// `./dom-globals.mjs` MUST be the first import: it installs window/document
// before react-dom is evaluated (react-dom freezes browser detection at load).
import './dom-globals.mjs'

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment, getDom } from './dom-globals.mjs'

export { React, createRoot, installDomEnvironment, getDom }
export const act = React.act

const CLIENT_URL = new URL('../../client.js', import.meta.url)

// The one place in client.js where the module object literal is returned. We
// splice in `__test` exactly like test/client-module.test.mjs does, so tests can
// reach the internal components/controller without changing production code.
const REGISTRATION_MARKER =
  "return {\n      inject: ['slots', 'connection', 'locale', 'layout'],"

const TEST_EXPORTS = [
  'createController', 'MainPanel', 'SetupFlow', 'ChannelsView', 'ChannelDetailView',
  'MembersView', 'MemberRow', 'QuestionsView', 'HomeView', 'Button', 'StateDot',
  'ErrorNotice', 'ErrorBoundary', 'buildSupportReport', 'PairingCodesView',
]

/**
 * Load client.js through the real DSH module-loader contract with the REAL react package.
 * Returns { mod, registration }.
 */
export function loadClient({ injectTest = true } = {}) {
  if (typeof globalThis.document === 'undefined') {
    throw new Error('call installDomEnvironment() before loadClient()')
  }
  let source = readFileSync(CLIENT_URL, 'utf8')
  if (injectTest) {
    if (!source.includes(REGISTRATION_MARKER)) {
      throw new Error('client.js registration marker changed — update test/dom/harness.mjs TEST_EXPORTS')
    }
    source = source.replace(
      REGISTRATION_MARKER,
      `return {\n      __test: { ${TEST_EXPORTS.join(', ')} },\n      inject: ['slots', 'connection', 'locale', 'layout'],`,
    )
  }
  let registration
  globalThis.window.__ModuleLoader__ = {
    load(value) { registration = value },
  }
  // Runs in the current context (not a fresh vm realm) so the injected React,
  // react-dom and the jsdom document all share one realm.
  vm.runInThisContext(source, { filename: 'client.js' })
  if (!registration || typeof registration.factory !== 'function') {
    throw new Error('client.js did not register through window.__ModuleLoader__.load')
  }
  const mod = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)}) — the DSH client factory must only require 'react'`)
  })
  return { mod, registration }
}

/** Build a ctx shaped like the DSH client context, with a recording fake RPC. */
export function createContext({ rpcCall, locale } = {}) {
  const calls = []
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      calls.push({ channel, endpoint, payload })
      if (typeof rpcCall === 'function') return rpcCall(channel, endpoint, payload, signal)
      return { ok: true, value: {} }
    },
  }
  const ctx = {
    locale: locale ?? {
      current: 'en',
      resolveText: (value) => (typeof value === 'string' ? value : (value?.en ?? value?.zh ?? '')),
      bind: () => (key) => key,
      subscribe: () => () => {},
      register: () => () => {},
    },
    connection: { rpc },
  }
  return { ctx, calls, rpc }
}

/** A surface.wait that never resolves until the caller aborts — keeps MainPanel's poll loop quiet. */
export function hangingSurfaceWait(_channel, endpoint, _payload, signal) {
  if (endpoint !== 'surface.wait') return undefined
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/** Mount a React element into a real jsdom container under `act`. */
export function mount(element, { container } = {}) {
  const host = container ?? globalThis.document.createElement('div')
  if (!container) globalThis.document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(element) })
  return {
    container: host,
    root,
    render(next) { act(() => { root.render(next) }) },
    unmount() {
      act(() => { root.unmount() })
      if (!container) host.remove()
    },
  }
}

/** Flush pending microtasks (and any React work they schedule) inside `act`. */
export async function flush() {
  await act(async () => { await Promise.resolve() })
}

/** Run an async body under `act` so state updates + effects are flushed deterministically. */
export async function actAsync(body) {
  await act(async () => { await body() })
}

/** Dispatch a real bubbling click (React's root listener picks it up). */
export function click(element) {
  act(() => {
    element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** Type into a controlled input the way a browser does, so React's onChange fires. */
export function typeInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
}

// Decorative glyphs the client appends inside buttons (picker '›', back '←').
const BUTTON_GLYPHS = /[›←→]/g

/** Find the first button whose visible text equals `label` (ignoring arrow glyphs). */
export function buttonByText(root, label) {
  return [...root.querySelectorAll('button')]
    .find((button) => button.textContent.replace(BUTTON_GLYPHS, '').trim() === label)
}

/** All visible text under a node (real DOM textContent). */
export function textOf(node) {
  return node.textContent ?? ''
}