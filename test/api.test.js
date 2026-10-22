// Route behaviour on top of the index, over HTTP against the real server.
/* eslint-disable no-restricted-syntax */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tg18Storage, tempDir } = require('./helpers/server');
const { storeInstance } = require('./helpers/dicom');

const STUDY = '2.16.124.113543.6004.101.103.20021117.162333.1';
const SERIES = `${STUDY}.002`;

const get = (server, url) => fetch(server.url + url).then(async (r) => ({ status: r.status, body: await r.json() }));

describe('TG18 study', () => {
  let server;
  before(async () => {
    server = await startServer({ storagePath: tg18Storage() });
  });
  after(async () => {
    await server.stop();
  });

  test('the health check finds the patient the viewer shows', async () => {
    // check_aapm.js waits for "AAPM, Test Patterns" in the study list
    const { body } = await get(server, '/rs/studies?limit=101&offset=0&fuzzymatching=false&includefield=00081030%2C00080060');
    assert.equal(body.length, 1);
    assert.equal(body[0]['00100010'].Value[0].Alphabetic, 'AAPM^Test^Patterns');
  });

  test('instances are sorted by instance number', async () => {
    const { body } = await get(server, `/rs/studies/${STUDY}/series/${SERIES}/instances`);
    assert.deepEqual(
      body.map((i) => i['00200013'].Value[0]),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  test('offset skips instances in SOP Instance UID order, then sorts', async () => {
    const { body } = await get(server, `/rs/studies/${STUDY}/series/${SERIES}/instances?offset=5`);
    assert.deepEqual(
      body.map((i) => i['00080018'].Value[0]),
      Array.from({ length: 15 }, (_, i) => `${SERIES}.0${String(i + 6).padStart(2, '0')}`),
    );
  });

  test('every instance in the metadata has a frame that can be fetched', async () => {
    const { body } = await get(server, `/rs/studies/${STUDY}/series/${SERIES}/metadata`);
    assert.equal(body.length, 20);
    const res = await fetch(`${server.url}/rs/studies/${STUDY}/series/${SERIES}/instances/${body[19]['00080018'].Value[0]}/frames/1`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    const rows = body[19]['00280010'].Value[0];
    const cols = body[19]['00280011'].Value[0];
    const bytesPerPixel = body[19]['00280100'].Value[0] / 8;
    assert.ok(buf.length > rows * cols * bytesPerPixel, 'frame smaller than the image');
  });

  test('the viewer page and its config are served', async () => {
    for (const url of ['/', '/app-config.js', '/viewer/rs/studies']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(server.url + url);
      assert.equal(res.status, 200, url);
      // eslint-disable-next-line no-await-in-loop
      await res.arrayBuffer();
    }
  });
});

describe('query parameters', () => {
  let server;
  let storagePath;
  before(async () => {
    storagePath = path.join(tempDir('api'), 'data');
    const base = { '00080016': '1.2.840.10008.5.1.4.1.1.2', '00080060': 'CT', '00200013': '1' };
    storeInstance(storagePath, { ...base, '00100010': 'MÜLLER^HANS', '00100020': 'M1', '0020000D': '5.1', '0020000E': '5.1.1', '00080018': '5.1.1.1', '00080020': '20240110' });
    storeInstance(storagePath, { ...base, '00100010': 'MULDER^FOX', '00100020': 'M2', '0020000D': '5.2', '0020000E': '5.2.1', '00080018': '5.2.1.1', '00080020': '20240220' });
    server = await startServer({ storagePath });
  });
  after(async () => {
    await server.stop();
  });

  const studyUids = (body) => body.map((s) => s['0020000D'].Value[0]);

  test('names get a trailing wildcard and are case-insensitive', async () => {
    assert.deepEqual(studyUids((await get(server, '/rs/studies?PatientName=mul')).body), ['5.2']);
    assert.deepEqual(studyUids((await get(server, '/rs/studies?PatientName=*mul*')).body), ['5.2']);
  });

  test('OHIF date range filter', async () => {
    assert.deepEqual(studyUids((await get(server, '/rs/studies?StudyDate=20240201-20240229')).body), ['5.2']);
    assert.deepEqual(studyUids((await get(server, '/rs/studies?StudyDate=20240101-')).body), ['5.1', '5.2']);
  });

  test('non-ASCII names come back as UTF-8 of the stored bytes', async () => {
    const { body } = await get(server, '/rs/studies?PatientID=M1');
    assert.equal(body[0]['00100010'].Value[0].Alphabetic, 'MÜLLER^HANS');
  });

  test('a study imported while running shows up on the next query', async () => {
    storeInstance(storagePath, {
      '00080016': '1.2.840.10008.5.1.4.1.1.2',
      '00100010': 'NEW^ONE',
      '0020000D': '5.3',
      '0020000E': '5.3.1',
      '00080018': '5.3.1.1',
    });
    assert.deepEqual(studyUids((await get(server, '/rs/studies')).body), ['5.1', '5.2', '5.3']);
  });

  test('unknown studies give empty lists and missing frames 404', async () => {
    assert.deepEqual((await get(server, '/rs/studies/9.9/series')).body, []);
    const res = await fetch(`${server.url}/rs/studies/5.1/series/5.1.1/instances/9.9/frames/1`);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });
});
