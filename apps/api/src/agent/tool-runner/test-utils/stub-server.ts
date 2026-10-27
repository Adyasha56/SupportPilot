import { createServer, IncomingMessage, ServerResponse } from 'node:http';

export interface StubServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export type StubHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** A real listening server on 127.0.0.1, ephemeral port - never a mock of fetch/http. */
export function startStubServer(handler: StubHandler): Promise<StubServer> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
