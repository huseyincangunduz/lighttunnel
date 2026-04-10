import * as tls from "tls";
import * as fs from "fs";
import {
  FrameDecoder,
  TcpMessage,
  TcpHeader,
  encodeMessage,
  generateId,
} from "./protocol";

export interface ClientTcpConnectionOptions {
  proxyHost: string;
  proxyPort: number;
  serviceName: string;
  tlsCa?: Buffer;
  tlsCert?: Buffer;
  tlsKey?: Buffer;
  /** Bağlantı kopunca kaç ms sonra tekrar denensin? (varsayılan: 5000) */
  reconnectDelayMs?: number;
}

type RequestHandler = (
  header: TcpHeader,
  body: Buffer,
) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

export class ClientTcpConnection {
  private readonly opts: ClientTcpConnectionOptions;
  private socket?: tls.TLSSocket;
  private decoder = new FrameDecoder();
  private handler?: RequestHandler;
  private reconnectTimer?: NodeJS.Timeout;
  private destroying = false;

  constructor(opts: ClientTcpConnectionOptions) {
    this.opts = opts;
  }

  /** Proxy'ye bağlan ve gelen REQUEST'leri işle. */
  start(handler: RequestHandler): void {
    this.handler = handler;
    this.connect();
  }

  destroy(): void {
    this.destroying = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
  }

  // ─── Bağlantı ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.destroying) return;

    const { proxyHost, proxyPort, tlsCa, tlsCert, tlsKey } = this.opts;
    console.log(
      `[ClientTcpConnection] Proxy'ye bağlanıyor: ${proxyHost}:${proxyPort}`,
    );

    this.decoder = new FrameDecoder();

    const socket = tls.connect({
      host: proxyHost,
      port: proxyPort,
      ca: tlsCa,
      cert: tlsCert,
      key: tlsKey,
      rejectUnauthorized: tlsCa !== undefined,
    });

    this.socket = socket;

    socket.once("secureConnect", () => {
      console.log(`[ClientTcpConnection] TLS bağlantısı kuruldu.`);
      // Servis adını kaydet
      socket.write(
        encodeMessage({ type: "REGISTER", serviceName: this.opts.serviceName }),
      );
    });

    socket.on("data", (data: Buffer) => {
      this.decoder.push(data, (msg) => this.handleMessage(msg, socket));
    });

    socket.on("close", () => {
      if (!this.destroying) {
        const delay = this.opts.reconnectDelayMs ?? 5000;
        console.log(
          `[ClientTcpConnection] Bağlantı kapandı, ${delay}ms sonra yeniden bağlanılacak.`,
        );
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });

    socket.on("error", (err) => {
      console.error(`[ClientTcpConnection] Socket hatası:`, err.message);
    });
  }

  // ─── Mesaj işleme ────────────────────────────────────────────────────────

  private async handleMessage(
    msg: TcpMessage,
    socket: tls.TLSSocket,
  ): Promise<void> {
    const { header, body } = msg;

    if (header.type === "REGISTER_ACK") {
      console.log(`[ClientTcpConnection] Kaydedildi: "${header.serviceName}"`);
      return;
    }

    if (header.type === "PING") {
      socket.write(encodeMessage({ type: "PONG" }));
      return;
    }

    if (header.type === "REQUEST" && header.requestId) {
      if (!this.handler) return;
      try {
        const result = await this.handler(header, body);
        const resHeader: TcpHeader = {
          type: "RESPONSE",
          requestId: header.requestId,
          status: result.status,
          headers: result.headers,
        };
        socket.write(encodeMessage(resHeader, result.body));
      } catch (err) {
        console.error("[ClientTcpConnection] Handler hatası:", err);
        const errHeader: TcpHeader = {
          type: "RESPONSE",
          requestId: header.requestId,
          status: 502,
          headers: { "content-type": "application/json" },
        };
        socket.write(
          encodeMessage(
            errHeader,
            Buffer.from(JSON.stringify({ error: String(err) })),
          ),
        );
      }
    }
  }
}

// ─── Fabrika ─────────────────────────────────────────────────────────────────

export function buildClientTcpConnection(
  serviceName: string,
): ClientTcpConnection {
  const proxyHost = process.env.PROXY_HOST ?? "localhost";
  const proxyPort = parseInt(process.env.PROXY_TCP_PORT ?? "14400", 10);

  const caPath = process.env.TLS_CA;
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;

  return new ClientTcpConnection({
    proxyHost,
    proxyPort,
    serviceName,
    tlsCa: caPath ? fs.readFileSync(caPath) : undefined,
    tlsCert: certPath ? fs.readFileSync(certPath) : undefined,
    tlsKey: keyPath ? fs.readFileSync(keyPath) : undefined,
  });
}
