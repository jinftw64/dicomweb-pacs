// The failure modes that took production down, checked against the real
// process: forked children, the 128 association limit, ports held after stop,
// and restarts failing with EADDRINUSE.
/* eslint-disable no-restricted-syntax */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tg18Storage, childPids, canConnect, sleep } = require('./helpers/server');

const STUDY = '2.16.124.113543.6004.101.103.20021117.162333.1';
const SERIES = `${STUDY}.002`;
const linuxOnly = { skip: process.platform !== 'linux' && 'needs /proc' };

describe('server process', () => {
  test('never forks, even after more than 128 queries', linuxOnly, async () => {
    const server = await startServer({ storagePath: tg18Storage() });
    try {
      // the old SCP refused every association after 128 with "Local Limit Exceeded"
      for (let i = 0; i < 300; i += 1) {
        const path = i % 2 ? '/rs/studies' : `/rs/studies/${STUDY}/series/${SERIES}/metadata`;
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(server.url + path);
        // eslint-disable-next-line no-await-in-loop
        const body = await res.json();
        assert.equal(res.status, 200, `query ${i}`);
        assert.equal(body.length, i % 2 ? 1 : 20, `query ${i} returned ${body.length} results`);
      }
      assert.deepEqual(childPids(server.child.pid), [], 'server has child processes');
    } finally {
      await server.stop();
    }
  });

  test('does not listen on the DICOM port', async () => {
    const server = await startServer({ storagePath: tg18Storage() });
    try {
      await fetch(`${server.url}/rs/studies`).then((r) => r.json());
      assert.equal(await canConnect(server.dicomPort), false, `something listens on ${server.dicomPort}`);
    } finally {
      await server.stop();
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} after serving queries frees the port so an immediate restart works`, async () => {
      const storagePath = tg18Storage();
      const first = await startServer({ storagePath });
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await fetch(`${first.url}/rs/studies`).then((r) => r.json());
      }
      const { port, dicomPort } = first;
      const { pid } = first.child;
      await first.stop(signal);

      // nothing of the old process may survive and keep the port
      if (process.platform === 'linux') {
        assert.deepEqual(childPids(pid), []);
      }
      assert.equal(await canConnect(port), false, 'port still open after stop');

      // same ports right away, like pm2 restart / the health check does
      const second = await startServer({ storagePath, port, dicomPort });
      try {
        const res = await fetch(`${second.url}/rs/studies`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).length, 1);
        assert.doesNotMatch(second.output(), /EADDRINUSE/);
      } finally {
        await second.stop();
      }
    });
  }

  test('serves concurrent queries', async () => {
    const server = await startServer({ storagePath: tg18Storage() });
    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () => fetch(`${server.url}/rs/studies/${STUDY}/series/${SERIES}/instances`).then((r) => r.json())),
      );
      responses.forEach((body) => assert.equal(body.length, 20));
      await sleep(100);
      if (process.platform === 'linux') {
        assert.deepEqual(childPids(server.child.pid), []);
      }
    } finally {
      await server.stop();
    }
  });
});
