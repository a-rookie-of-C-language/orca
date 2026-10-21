import { superviseRuntime } from './runtime-supervisor.mjs'
const child = superviseRuntime({
  entry: '../.cache/orcad-dev/orcad-server.js',
  input: process.stdin,
  owner: process
})
child.on('exit', (c) => console.log('CHILD EXIT', c))
setTimeout(() => console.log('alive at 8s'), 8000)
