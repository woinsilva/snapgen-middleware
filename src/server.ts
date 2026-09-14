import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = createApp(env);

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'server_started', port: env.PORT }));
});
