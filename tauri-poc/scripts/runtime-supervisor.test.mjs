import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { superviseRuntime } from './runtime-supervisor.mjs'

function fixture() {
  const child = new EventEmitter()
  child.connected = true
  let disconnects = 0
  child.disconnect = () => {
    disconnects++
    child.connected = false
  }
  const input = new PassThrough()
  const owner = new EventEmitter()
  let spec
  superviseRuntime({
    entry: '/runtime/orcad.js',
    input,
    owner,
    spawn: (value) => {
      spec = value
      return child
    }
  })
  return { child, input, owner, spec, disconnects: () => disconnects }
}

test('starts Node with the existing IPC ownership contract, not Electron', () => {
  const f = fixture()
  assert.equal(f.spec.program, process.execPath)
  assert.equal(f.spec.env.ORCA_BUNDLED_LAUNCHER_CHANNEL, '1')
  assert.equal(f.spec.detached, true)
  assert.equal(f.spec.stdio[3], 'ipc')
  assert.deepEqual(f.spec.args, [
    '/runtime/orcad.js',
    '--bind',
    '127.0.0.1',
    '--port',
    '0',
    '--json'
  ])
  f.child.emit('exit', 0)
})

for (const event of ['end', 'error', 'data']) {
  test(`owner pipe ${event} disconnects only the owned runtime exactly once`, () => {
    const f = fixture()
    f.input.emit(event, event === 'error' ? new Error('closed') : Buffer.from('stop'))
    f.owner.emit('SIGTERM')
    assert.equal(f.disconnects(), 1)
    f.child.emit('exit', 0)
    assert.equal(f.owner.listenerCount('SIGTERM'), 0)
    assert.equal(f.input.listenerCount('end'), 0)
    assert.equal(f.owner.exitCode, 0)
  })
}

test('reports abnormal child exit instead of retaining stale readiness', () => {
  const f = fixture()
  f.child.emit('exit', null)
  assert.equal(f.owner.exitCode, 1)
  assert.equal(f.disconnects(), 0)
})
