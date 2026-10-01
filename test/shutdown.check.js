import { spawn } from 'node:child_process';
import http from 'node:http';

const port = 8071;
const child = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(port), QUIET_LOGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

const waitForReady = () =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      http
        .get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('server never became ready'));
      else setTimeout(poll, 200);
    };
    poll();
  });

await waitForReady();
console.log('server ready');

const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 40 });
const open = (i) =>
  new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', agent: keepAlive, headers: { 'x-api-key': `ka${i}` } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', resolve);
  });

await Promise.all(Array.from({ length: 40 }, (_, i) => open(i)));
console.log('40 keep-alive connections established and idle');

const inflightDone = new Promise((resolve) => {
  http
    .get(
      { host: '127.0.0.1', port, path: '/quotes/SGSIN/NLRTM?cargoClass=container&weightKg=7000', agent: keepAlive },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    )
    .on('error', (e) => resolve({ status: 'ERR', body: e.message }));
});

const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
const t0 = Date.now();
setTimeout(() => {
  child.kill('SIGTERM');
  console.log('SIGTERM sent while a quote request is in flight');
}, 10);
const { code, signal } = await Promise.race([
  exited,
  new Promise((r) => setTimeout(() => r({ code: 'TIMEOUT', signal: null }), 20000))
]);
const elapsed = Date.now() - t0;
const inflight = await inflightDone;
console.log(`exit code=${code} signal=${signal} after ${elapsed} ms`);
console.log(`in-flight request completed with status ${inflight.status}`);
console.log('--- server output ---');
process.stdout.write(output);
if (code === 'TIMEOUT') {
  child.kill('SIGKILL');
  process.exit(1);
}
process.exit(code === 0 ? 0 : 1);
