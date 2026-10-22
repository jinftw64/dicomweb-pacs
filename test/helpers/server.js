// Runs the real server (node src/app.js, as pm2 does) against a temporary
// storage folder so tests see the same process behaviour as production.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { importFiles } = require('../../src/import');

const ROOT = path.join(__dirname, '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dicomweb-pacs-${prefix}-`));
}

// storage folder holding the TG18 reference study from ./import
function tg18Storage() {
  const dir = tempDir('data');
  const storagePath = path.join(dir, 'data');
  const { failed } = importFiles(path.join(ROOT, 'import'), storagePath);
  if (failed.length) {
    throw new Error(`fixture import failed: ${JSON.stringify(failed)}`);
  }
  return storagePath;
}

const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function waitForHttp(url, child, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode} before listening`);
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url);
      // eslint-disable-next-line no-await-in-loop
      await res.arrayBuffer();
      return;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
    }
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs}ms`);
}

/**
 * Starts the server. Returns { url, port, dicomPort, child, output(), stop(signal) }.
 * dicomPort is the configured DIMSE port (config.source.port) the old code listened on.
 */
async function startServer({ storagePath, port, dicomPort }) {
  const webPort = port || (await freePort());
  const scpPort = dicomPort || (await freePort());
  const logDir = tempDir('logs');
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_CONFIG: JSON.stringify({
        storagePath,
        logDir,
        webserverPort: webPort,
        source: { aet: 'DICOMWEB_PACS', ip: '127.0.0.1', port: String(scpPort) },
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const url = `http://127.0.0.1:${webPort}`;
  await waitForHttp(`${url}/rs/studies`, child);

  return {
    url,
    port: webPort,
    dicomPort: scpPort,
    child,
    logDir,
    output: () => output,
    exited,
    async stop(signal = 'SIGINT', timeoutMs = 10000) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
      const timer = sleep(timeoutMs).then(() => 'timeout');
      const result = await Promise.race([exited, timer]);
      if (result === 'timeout') {
        child.kill('SIGKILL');
        throw new Error(`server did not exit within ${timeoutMs}ms after ${signal}`);
      }
      return result;
    },
  };
}

// pids of all live processes whose parent is pid (Linux /proc)
function childPids(pid) {
  return fs
    .readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
        // the command name can contain spaces, so parse after the last ')'
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        return ppid === pid;
      } catch {
        return false;
      }
    })
    .map(Number);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

module.exports = { startServer, tg18Storage, tempDir, freePort, childPids, canConnect, sleep, ROOT };
