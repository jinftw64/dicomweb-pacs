// Replays every request recorded from the old C-FIND implementation against the
// new one and requires the same responses, so the viewer cannot tell them apart.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const dicomParser = require('dicom-parser');
const { startServer, tg18Storage } = require('./helpers/server');
const baseline = require('./fixtures/qido-baseline.json');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// the multipart boundary is random, so only the part payload is compared
function framePayload(buf, contentType) {
  const boundary = /boundary='([^']+)'/.exec(contentType)[1];
  const text = buf.toString('latin1');
  return buf.subarray(text.indexOf('\r\n\r\n') + 4, text.lastIndexOf(`\r\n--${boundary}--`));
}

// files are byte-for-byte different only in the preamble/meta written by the
// old DIMSE store, so compare all DICOM elements instead
function datasetHash(buf) {
  const ds = dicomParser.parseDicom(buf);
  return sha256(
    Buffer.concat(
      Object.keys(ds.elements)
        .sort()
        .map((k) => {
          const e = ds.elements[k];
          return Buffer.concat([Buffer.from(k), buf.subarray(e.dataOffset, e.dataOffset + e.length)]);
        }),
    ),
  );
}

// the old order for offset on instances was the arrival order of C-STOREs;
// it is covered separately in api.test.js
const ORDER_DEPENDENT = ['/instances?offset='];

let server;
before(async () => {
  server = await startServer({ storagePath: tg18Storage() });
});
after(async () => {
  await server.stop();
});

baseline
  .filter((c) => !ORDER_DEPENDENT.some((s) => c.url.includes(s)))
  .forEach((expected) => {
    test(`GET ${expected.url}`, async () => {
      const res = await fetch(server.url + expected.url);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(res.status, expected.status);

      if (expected.body !== undefined) {
        assert.equal(res.headers.get('content-type'), expected.contentType);
        assert.deepStrictEqual(JSON.parse(buf.toString('utf8')), expected.body);
      } else if (expected.framePayloadSha256) {
        assert.equal(buf.length, expected.length);
        assert.equal(sha256(framePayload(buf, res.headers.get('content-type'))), expected.framePayloadSha256);
      } else if (expected.datasetSha256) {
        assert.equal(buf.length, expected.length);
        assert.equal(datasetHash(buf), expected.datasetSha256);
      }
    });
  });
