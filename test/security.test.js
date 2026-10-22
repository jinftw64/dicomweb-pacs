// UIDs from the URL become file paths under the storage folder, so anything
// that is not a plain UID must be refused before touching the filesystem.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startServer, tempDir, ROOT } = require('./helpers/server');
const { importFiles } = require('../src/import');

const TG18 = path.join(ROOT, 'import', 'TG18-LN-1k-01.dcm');
const STUDY = '2.16.124.113543.6004.101.103.20021117.162333.1';
const SERIES = `${STUDY}.002`;
const SOP = `${SERIES}.001`;

describe('path traversal', () => {
  let server;
  before(async () => {
    const root = tempDir('traversal');
    const storagePath = path.join(root, 'data');
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(TG18, path.join(root, 'src', 'a.dcm'));
    importFiles(path.join(root, 'src'), storagePath);
    // a real, servable DICOM file next to (not inside) the storage folder
    fs.copyFileSync(TG18, path.join(root, 'secret'));
    server = await startServer({ storagePath });
  });
  after(async () => {
    await server.stop();
  });

  // raw request: fetch() would normalize "%2E%2E" segments away before sending
  const status = (url) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port, path: url }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });

  test('wadouri refuses traversal in any UID parameter', async () => {
    assert.equal(await status(`/wadouri?studyUID=${STUDY}&seriesUID=${SERIES}&objectUID=..%2F..%2Fsecret`), 400);
    assert.equal(await status(`/wadouri?studyUID=..&seriesUID=${SERIES}&objectUID=secret`), 400);
    assert.equal(await status(`/wadouri?studyUID=${STUDY}&seriesUID=..%2F..&objectUID=${SOP}`), 400);
    assert.equal(await status(`/wadouri?studyUID=%2Fetc&seriesUID=${SERIES}&objectUID=passwd`), 400);
  });

  test('frames refuses traversal in encoded path segments', async () => {
    assert.equal(await status(`/rs/studies/${STUDY}/series/${SERIES}/instances/..%2F..%2Fsecret/frames/1`), 400);
    assert.equal(await status(`/rs/studies/%2E%2E/series/${SERIES}/instances/secret/frames/1`), 400);
    assert.equal(await status(`/rs/studies/${STUDY}/series/x/instances/${SOP}/frames/1`), 400);
  });

  test('valid UIDs still work', async () => {
    assert.equal(await status(`/wadouri?studyUID=${STUDY}&seriesUID=${SERIES}&objectUID=${SOP}`), 200);
    assert.equal(await status(`/rs/studies/${STUDY}/series/${SERIES}/instances/9.9/frames/1`), 404);
  });
});
