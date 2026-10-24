import { createApp } from './app';

const port = Number(process.env.MOCK_STORE_PORT ?? 4100);
const host = '127.0.0.1';

const app = createApp();

app.listen(port, host, () => {
  console.log(`mock-store listening on http://${host}:${port}`);
});
