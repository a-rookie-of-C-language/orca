import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DEV_RESTART_EXIT_CODE, superviseDevelopmentApp } from './dev-app-supervisor.mjs'

function fixture() {
  const children = []
  const killed = []
  const owner = {}
  let viteStops = 0
  const supervisor = superviseDevelopmentApp({
    owner,
    stopVite: () => viteStops++,
    launch: () => {
      const child = new EventEmitter()
      child.kill = (signal) => killed.push({ child, signal })
      children.push(child)
      return child
    }
  })
  return { children, killed, owner, supervisor, viteStops: () => viteStops }
}

test('keeps Vite alive across repeated native restart requests', () => {
  const f = fixture()
  f.children[0].emit('exit', DEV_RESTART_EXIT_CODE, null)
  f.children[1].emit('exit', DEV_RESTART_EXIT_CODE, null)
  assert.equal(f.children.length, 3)
  assert.equal(f.viteStops(), 0)
  assert.equal(f.owner.exitCode, undefined)
  f.children[2].emit('exit', 0, null)
  assert.equal(f.viteStops(), 1)
  assert.equal(f.owner.exitCode, 0)
})

for (const [code, signal, expected] of [
  [0, null, 0],
  [2, null, 2],
  [null, 'SIGTERM', 1]
]) {
  test(`does not relaunch after ordinary termination (${code}, ${signal})`, () => {
    const f = fixture()
    f.children[0].emit('exit', code, signal)
    assert.equal(f.children.length, 1)
    assert.equal(f.viteStops(), 1)
    assert.equal(f.owner.exitCode, expected)
  })
}

test('interrupting the launcher stops the current generation, not an exited predecessor', () => {
  const f = fixture()
  f.children[0].emit('exit', DEV_RESTART_EXIT_CODE, null)
  f.supervisor.stop('SIGTERM')
  f.supervisor.stop('SIGTERM')
  f.children[1].emit('exit', DEV_RESTART_EXIT_CODE, null)
  assert.equal(f.children.length, 2)
  assert.deepEqual(f.killed, [{ child: f.children[1], signal: 'SIGTERM' }])
  assert.equal(f.viteStops(), 1)
})

test('native shell and development owner agree on the restart exit code', () => {
  const source = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
  assert.match(source, new RegExp(`const DEV_RESTART_EXIT_CODE: i32 = ${DEV_RESTART_EXIT_CODE};`))
})

test('a launch error stops Vite without retrying a broken executable', (t) => {
  t.mock.method(console, 'error', () => {})
  const owner = {}
  let stopped = 0
  superviseDevelopmentApp({
    owner,
    launch: () => {
      throw new Error('spawn failed')
    },
    stopVite: () => stopped++
  })
  assert.equal(owner.exitCode, 1)
  assert.equal(stopped, 1)
})

test('an asynchronous spawn failure cannot be mistaken for a restart', (t) => {
  t.mock.method(console, 'error', () => {})
  const f = fixture()
  f.children[0].emit('error', new Error('spawn failed'))
  f.children[0].emit('exit', DEV_RESTART_EXIT_CODE, null)
  assert.equal(f.children.length, 1)
  assert.equal(f.owner.exitCode, 1)
  assert.equal(f.viteStops(), 1)
})
