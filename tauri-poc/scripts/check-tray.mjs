import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs';

// Live Windows proof for tray parity: ensure the notification-area icon,
// flip the attention badge on and off, and rebuild translated labels, all
// against the real shell. TauriOnly reports success after the shell accepts
// the icon/menu/tooltip, so a true result is the OS proof. Menu-item clicks
// (Open/Settings/Quit) still need a visible run with OS-level input and are
// not exercised here. Refuses visible windows and foreign checkouts, and
// leaves attention off when done.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224';
const connections = new Set();
let page;

const invoke = (command, args) =>
  page.evaluate(
    (params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args),
    { command, args },
  );

try {
  page = await connectDevelopmentRenderer(endpoint, connections);
  await assertReadyHidden(page, root);
  const identity = await page.evaluate(() => window.api.app.getIdentity());
  assert.ok(identity, 'The renderer has no app identity.');
  const args = {
    isDev: identity.isDev ?? false,
    devLabel: identity.devLabel ?? null,
    openLabel: 'Open Orca',
    settingsLabel: null,
    checkUpdatesLabel: null,
    quitLabel: 'Quit',
    activityWaiting: 'Orca - activity waiting',
    activityWaitingSuffix: 'activity waiting',
  };
  const ensured = await invoke('poc_tray_ensure', { args });
  assert.equal(ensured, true, 'The shell did not accept the tray icon.');
  const attentionOn = await invoke('poc_tray_set_attention', { args: { active: true } });
  assert.equal(attentionOn, true, 'The attention repaint did not apply.');
  const rebuilt = await invoke('poc_tray_rebuild', { args });
  assert.equal(rebuilt, true, 'The label rebuild did not apply.');
  const attentionOff = await invoke('poc_tray_set_attention', { args: { active: false } });
  assert.equal(attentionOff, true, 'The attention reset did not apply.');
  await assertReadyHidden(page, root);
  const evidence = { ensured, attentionOn, rebuilt, attentionOff, at: new Date().toISOString() };
  await writeFile(
    join(root, '.cache', 'tauri-tray-check-latest.json'),
    JSON.stringify(evidence, null, 2),
  );
  console.log('Tray ensures, badges, rebuilds, and resets against the live shell.');
} finally {
  try {
    await invoke('poc_tray_set_attention', { args: { active: false } }).catch(() => {});
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})));
  }
}