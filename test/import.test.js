const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { importFiles } = require('../src/import');
const { writeDicom } = require('./helpers/dicom');
const { tempDir, ROOT } = require('./helpers/server');

const attrs = (study, sop) => ({ '0020000D': study, '0020000E': `${study}.1`, '00080018': sop, '00100010': 'A^B' });

test('stores files as <study>/<sop>, including nested source folders', () => {
  const src = tempDir('src');
  const storage = path.join(tempDir('dst'), 'data');
  writeDicom(path.join(src, 'a.dcm'), attrs('1.2', '1.2.1.1'));
  writeDicom(path.join(src, 'nested', 'deeper', 'b'), attrs('1.3', '1.3.1.1'));

  const result = importFiles(src, storage);

  assert.equal(result.imported.length, 2);
  assert.ok(fs.existsSync(path.join(storage, '1.2', '1.2.1.1')));
  assert.ok(fs.existsSync(path.join(storage, '1.3', '1.3.1.1')));
  assert.deepEqual(
    fs.readFileSync(path.join(storage, '1.2', '1.2.1.1')),
    fs.readFileSync(path.join(src, 'a.dcm')),
  );
});

test('a second import skips what is already stored', () => {
  const src = tempDir('src');
  const storage = path.join(tempDir('dst'), 'data');
  writeDicom(path.join(src, 'a.dcm'), attrs('1.2', '1.2.1.1'));
  importFiles(src, storage);
  const again = importFiles(src, storage);
  assert.equal(again.imported.length, 0);
  assert.equal(again.skipped.length, 1);
});

test('non-DICOM files and unsafe UIDs are rejected', () => {
  const src = tempDir('src');
  const storage = path.join(tempDir('dst'), 'data');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'hello');
  writeDicom(path.join(src, 'evil.dcm'), attrs('..', '1.2.3'));
  writeDicom(path.join(src, 'nosop.dcm'), { '0020000D': '1.2', '0020000E': '1.2.1', '00080018': '' });

  const result = importFiles(src, storage);

  assert.equal(result.imported.length, 0);
  assert.deepEqual(result.failed.map((f) => path.basename(f.file)).sort(), ['evil.dcm', 'nosop.dcm', 'notes.txt']);
  assert.equal(fs.existsSync(storage), false);
});

test('npm run import works on the bundled TG18 study', () => {
  const storage = path.join(tempDir('cli'), 'data');
  const out = execFileSync(process.execPath, ['src/import.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_CONFIG: JSON.stringify({ storagePath: storage, logDir: tempDir('logs') }) },
    encoding: 'utf8',
  });
  assert.match(out, /20 imported, 0 skipped, 0 failed/);
  assert.equal(fs.readdirSync(path.join(storage, '2.16.124.113543.6004.101.103.20021117.162333.1')).length, 20);
});
