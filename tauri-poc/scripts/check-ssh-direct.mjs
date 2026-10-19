import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs';

// Live Windows proof for the direct-SSH path on Tauri: add a loopback target
// on a closed port, prove connect rejects exactly like Electron main (which
// lets connectTarget throw through ssh:connect), the failed state is readable
// via getState, and an sshStateChanged event reaches the renderer through the
// newly wired onStateChanged fan-out. testConnection stays a web-client stub
// (known gap) so the probe only records its shape. A refused TCP handshake
// exercises the full renderer -> orcad -> ssh2 stack without credentials.
// Refuses visible windows and foreign checkouts, and always removes the probe.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224';
const connections = new Set();
let page;
let targetId;

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  page = await connectDevelopmentRenderer(endpoint, connections);
  await assertReadyHidden(page, root);
  const hasApi = await page.evaluate(() => Boolean(window.api?.ssh?.connect));
  assert.equal(hasApi, true, 'The Tauri renderer has no window.api.ssh.');
  const added = await page.evaluate(() =>
    window.api.ssh.addTarget({
      target: { label: 'tauri-probe-loopback', host: '127.0.0.1', port: 9, username: 'orcaprobe' },
    }),
  );
  targetId = added?.target?.id ?? added?.id;
  assert.ok(targetId, 'addTarget returned no target id.');
  await page.evaluate(() => {
    window.__sshProbeEvents = [];
    window.__sshProbeUnsubscribe = window.api.ssh.onStateChanged((change) => {
      window.__sshProbeEvents.push(change);
    });
  });
  let connectError = null;
  try {
    await withTimeout(
      page.evaluate((id) => window.api.ssh.connect({ targetId: id }), targetId),
      90000,
      'ssh.connect',
    );
  } catch (error) {
    connectError = String(error?.message ?? error);
  }
  assert.ok(connectError, 'ssh.connect resolved for a dead port; Electron main rejects it.');
  assert.ok(
    /ssh/i.test(connectError),
    `ssh.connect rejected with an unrelated error: ${connectError}`,
  );
  // Why null is correct: the shared SshConnectionManager drops a failed transport, so both
  // shells report no retained state; the failure itself travels on sshStateChanged instead.
  const state = await page.evaluate((id) => window.api.ssh.getState({ targetId: id }), targetId);
  assert.equal(state, null, 'ssh.getState retained state for a failed transport.');
  const events = await page.evaluate(() => window.__sshProbeEvents);
  const terminal = events.filter((entry) => entry.targetId === targetId).map((entry) => entry.state?.status);
  assert.ok(terminal.includes('connecting'), 'No connecting sshStateChanged event reached the renderer.');
  assert.ok(
    terminal.some((status) => status !== undefined && status !== 'connecting' && status !== 'connected'),
    'No terminal sshStateChanged event reached the renderer for the failed connect.',
  );
  const tested = await page.evaluate((id) => window.api.ssh.testConnection({ targetId: id }), targetId);
  assert.equal(typeof tested?.success, 'boolean', 'ssh.testConnection lost its shape.');
  await page.evaluate(() => window.__sshProbeUnsubscribe?.());
  await page.evaluate((id) => window.api.ssh.disconnect({ targetId: id }), targetId);
  await page.evaluate((id) => window.api.ssh.removeTarget({ id }), targetId);
  targetId = null;
  const remaining = await page.evaluate(() => window.api.ssh.listTargets());
  assert.ok(
    (remaining ?? []).every((target) => target.label !== 'tauri-probe-loopback'),
    'The probe target survived removeTarget.',
  );
  await assertReadyHidden(page, root);
  const evidence = { connectError, state, tested, events, at: new Date().toISOString() };
  await writeFile(
    join(root, '.cache', 'tauri-ssh-direct-check-latest.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `Direct SSH fails like Electron and reports it on sshStateChanged (${terminal.join('>')}).`,
  );
} finally {
  try {
    if (targetId) {
      await page?.evaluate((id) => window.api.ssh.removeTarget({ id }), targetId).catch(() => {});
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})));
  }
}
