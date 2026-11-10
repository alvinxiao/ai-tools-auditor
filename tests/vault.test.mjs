import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeToolReport } from '../src/vault.mjs';

async function temporaryVault(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'auditor-vault-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('refresh changes the report while preserving personal content and one product note', async t => {
  const vault = await temporaryVault(t);
  const report = { id: 'example-tool', title: 'Example Tool', body: 'Verdict: watch' };
  const file = await writeToolReport(vault, report);
  const personal = '\r\nMy annotation: keep local files. 📝\r\n';
  await writeFile(file, 'My custom preface\r\n' + await readFile(file, 'utf8') + personal);
  await writeToolReport(vault, { ...report, title: 'Renamed Tool', body: 'Verdict: adapt' });
  const updated = await readFile(file, 'utf8');
  assert.ok(updated.startsWith('My custom preface\r\n'));
  assert.ok(updated.endsWith(personal));
  assert.ok(updated.includes('# Renamed Tool'));
  assert.ok(updated.includes('Verdict: adapt'));
  assert.ok(!updated.includes('Verdict: watch'));
  await writeToolReport(vault, { ...report, title: 'Renamed Tool', body: 'Verdict: adapt' });
  assert.equal(await readFile(file, 'utf8'), updated);
  assert.deepEqual(await readdir(path.join(vault, 'Tools')), ['example-tool.md']);
});

test('ambiguous or missing markers preserve the existing file', async t => {
  const vault = await temporaryVault(t);
  const report = { id: 'example', title: 'Example', body: 'Verdict: watch' };
  const file = await writeToolReport(vault, report);
  for (const content of ['My manually written note',
    '<!-- auditor:generated:end -->\n<!-- auditor:generated:start -->',
    '<!-- auditor:generated:start --><!-- auditor:generated:start --><!-- auditor:generated:end -->']) {
    await writeFile(file, content);
    await assert.rejects(writeToolReport(vault, report), /markers/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('rejects path traversal and section marker injection', async t => {
  const vault = await temporaryVault(t);
  await assert.rejects(writeToolReport(vault, { id: '../outside', title: 'X', body: 'X' }));
  await assert.rejects(writeToolReport(vault, {
    id: 'example', title: 'X', body: '<!-- auditor:generated:end -->',
  }));
  assert.deepEqual(await readdir(vault), []);
});
