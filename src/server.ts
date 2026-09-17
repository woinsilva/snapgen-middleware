import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { processIdentity } from './runtime/process-identity.js';

const env = loadEnv();
const app = createApp(env);

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'server_started', ...processIdentity, port: env.PORT }));
});

let shuttingDown = false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const jobs = app.locals.jobLifecycle?.beginShutdown?.() ?? { generation: { active: 0, total: 0 }, render: { active: 0, total: 0 } };
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'shutdown_started', ...processIdentity, signal: 'SIGTERM', jobs }));
  const deadline = setTimeout(() => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'shutdown_grace_expired', ...processIdentity, graceMs: 10_000 }));
    process.exit(0);
  }, 10_000);
  server.close(() => {
    clearTimeout(deadline);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'shutdown_completed', ...processIdentity }));
    process.exit(0);
  });
});
