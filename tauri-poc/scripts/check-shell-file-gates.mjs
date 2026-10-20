import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs';

// Live Windows proof for the pure-validation shell file gates: command names
// and camelCase wire shapes resolve, and refusal reasons match Electron main.
// Nothing here opens OS UI: every probe only stats, reads, or validates.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224';
const connections = new Set();
let page;
const scratch = mkdtempSync(join(tmpdir(), 'orca-tauri-file-gates-'));
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args }
  );
const settled = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error) })
  );
try {
  page = await connectDevelopmentRenderer(endpoint, connections);
  await assertReadyHidden(page, root);
  const relativeSound = await invoke('poc_notification_sound_path', {
    args: { path: 'relative-tone.mp3' }
  });
  assert.deepEqual(relativeSound, { ok: false, path: null, reason: 'invalid-path' });
  const missingSound = await invoke('poc_notification_sound_path', {
    args: { path: join(scratch, 'gone.mp3') }
  });
  assert.deepEqual(missingSound, { ok: false, path: null, reason: 'read-failed' });
  const badType = await invoke('poc_notification_sound_path', {
    args: { path: join(scratch, 'tone.txt') }
  });
  assert.deepEqual(badType, { ok: false, path: null, reason: 'unsupported-type' });
  const bigMp3 = join(scratch, 'big.mp3');
  writeFileSync(bigMp3, Buffer.alloc(10 * 1024 * 1024 + 1));
  const bigSound = await invoke('poc_notification_sound_path', { args: { path: bigMp3 } });
  assert.deepEqual(bigSound, { ok: false, path: null, reason: 'too-large' });
  const tinyMp3 = join(scratch, 'TONE.MP3');
  writeFileSync(tinyMp3, Buffer.from([1, 2]));
  const tinySound = await invoke('poc_notification_sound_path', { args: { path: tinyMp3 } });
  assert.deepEqual(tinySound, { ok: true, path: tinyMp3, reason: null });
  const missingIcon = await settled(
    invoke('poc_read_file_data_url', { path: join(scratch, 'missing.png') })
  );
  assert.equal(missingIcon.ok, false);
  const txtIcon = await settled(
    invoke('poc_read_file_data_url', { path: join(scratch, 'a.txt') })
  );
  assert.equal(txtIcon.ok, false);
  assert.match(txtIcon.error, /Repo icons must be PNG/);
  const tinyPng = join(scratch, 'ICON.PNG');
  writeFileSync(tinyPng, Buffer.from([1, 2, 3]));
  const icon = await invoke('poc_read_file_data_url', { path: tinyPng });
  assert.equal(icon.fileName, 'ICON.PNG');
  assert.equal(icon.dataUrl, 'data:image/png;base64,AQID');
  const pickedDir = join(scratch, 'picked.png');
  mkdirSync(pickedDir);
  const dirIcon = await settled(invoke('poc_read_file_data_url', { path: pickedDir }));
  assert.equal(dirIcon.ok, false);
  assert.doesNotMatch(dirIcon.error, /256KB or smaller/);
  const tooMany = await settled(
    invoke('poc_validate_dropped_paths', {
      paths: Array.from({ length: 257 }, () => 'C:\\\\a')
    })
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /too-many-paths/);
  const relDrop = await settled(
    invoke('poc_validate_dropped_paths', { paths: ['relative.txt'] })
  );
  assert.equal(relDrop.ok, false);
  assert.match(relDrop.error, /invalid-path/);
  const accepted = await invoke('poc_validate_dropped_paths', {
    paths: ['C:\\\\b.txt', '', 'C:\\\\b.txt']
  });
  assert.deepEqual(accepted, ['C:\\\\b.txt']);
  await assertReadyHidden(page, root);
  const evidence = { at: new Date().toISOString() };
  await writeFile(
    join(root, '.cache', 'tauri-shell-file-gates-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  );
  console.log('Shell file gates match Electron against the live shell.');
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {});
  }
  rmSync(scratch, { recursive: true, force: true });
}
