import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const shutdownGraceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 10000);
const shipments = Number(process.env.SHIPMENT_COUNT ?? 500);
const quiet = process.env.QUIET_LOGS === '1';

const app = createApp({ shipmentCount: shipments, quiet });

let shuttingDown = false;
let inFlight = 0;
let watchdog = null;
const sockets = new Set();

app.server.on('request', (req, res) => {
  inFlight += 1;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    inFlight -= 1;
      if (shuttingDown && inFlight === 0) {
        clearTimeout(watchdog);
        process.stdout.write('all in-flight requests drained\n');
        process.exit(0);
      }
  };
  res.on('finish', done);
  res.on('close', done);
});

app.server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

const port_ = await app.listen(port, host);
process.stdout.write(`logistics-api listening on http://${host}:${port_}\n`);
process.stdout.write(`shipments loaded: ${app.repo.size}\n`);
process.stdout.write(`graceful shutdown budget: ${shutdownGraceMs}ms\n`);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${signal} received, draining ${inFlight} in-flight request(s)\n`);
  const watchdog = setTimeout(() => {
    process.stderr.write(`drain timed out after ${shutdownGraceMs}ms, forcing close of ${sockets.size} socket(s)\n`);
    for (const socket of sockets) socket.destroy();
    process.exit(1);
  }, shutdownGraceMs);
  app.server.close(() => {
    clearTimeout(watchdog);
    if (inFlight === 0) process.exit(0);
  });
  app.server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandledRejection: ${reason}\n`);
});
