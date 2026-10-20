import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs';

// Live Windows proof that the legacy relay bridge answers from orcad: with no bridge running,
// the pane list is empty and attaching an unknown pane reports not-bridged (the same answers
// Electron gives when nothing is bridged), while an empty pty id is rejected by the orcad
// schema. Serving a real relay-era terminal needs a host that still runs one, which this
// machine cannot provide, so the probe pins the wiring — not the serving. Refuses visible
// windows and foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224';
const connections = new Set();
let page;

try {
  page = await connectDevelopmentRenderer(endpoint, connections);
  await assertReadyHidden(page, root);
  const hasApi = await page.evaluate(() => Boolean(window.api?.legacyRelayBridge?.listPanes));
  assert.equal(hasApi, true, 'The Tauri renderer has no window.api.legacyRelayBridge.');
  const panes = await page.evaluate(() => window.api.legacyRelayBridge.listPanes());
  assert.ok(Array.isArray(panes), `listPanes answered a non-array: ${typeof panes}.`);
  assert.equal(panes.length, 0, `Expected no bridged panes, got ${panes.length}.`);
  const attach = await page.evaluate(() =>
    window.api.legacyRelayBridge.attach({ ptyId: 'ssh:probe@@relay1' }),
  );
  assert.equal(attach?.status, 'not-bridged', `Unexpected attach verdict: ${attach?.status}.`);
  let emptyError = null;
  try {
    await page.evaluate(() => window.api.legacyRelayBridge.attach({ ptyId: '' }));
  } catch (error) {
    emptyError = String(error?.message ?? error);
  }
  assert.ok(emptyError, 'Empty ptyId resolved instead of failing schema validation.');
  const events = await page.evaluate(async () => {
    const seen = [];
    const off = [
      window.api.legacyRelayBridge.onPanes((p) => seen.push(['panes', p])),
      window.api.legacyRelayBridge.onData((e) => seen.push(['data', e])),
      window.api.legacyRelayBridge.onReplay((e) => seen.push(['replay', e])),
      window.api.legacyRelayBridge.onExit((e) => seen.push(['exit', e])),
    ];
    await new Promise((resolve) => setTimeout(resolve, 1000));
    off.forEach((dispose) => dispose());
    return seen;
  });
  assert.ok(Array.isArray(events), 'Event subscriptions did not settle to an array.');
  await assertReadyHidden(page, root);
  const evidence = { panes, attach, emptyError, events, at: new Date().toISOString() };
  await writeFile(
    join(root, '.cache', 'tauri-ssh-legacy-relay-bridge-check-latest.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log('Legacy relay bridge answers from orcad (no bridges; attach is not-bridged).');
} finally {
  await Promise.all([...connections].map((browser) => browser.close().catch(() => {})));
}
