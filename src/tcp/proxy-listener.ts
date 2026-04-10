import * as tls from "tls";
import * as fs from "fs";
import {
  FrameDecoder,
  TcpMessage,
  encodeMessage,
  generateId,
  TcpHeader,
} from "./protocol";

export interface ProxyTcpListenerOptions {
  host: string;
  port: number;
  tlsCert: Buffer;
  tlsKey: Buffer;
  tlsCa?: Buffer;
  /** mTLS: client sertifikası zorunlu mu? (varsayılan: true) */
  requireClientCert?: boolean;
}

interface PendingRequest {
  resolve: (msg: TcpMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ConnectedClient {
  id: string;
  serviceName: string;
  socket: tls.TLSSocket;
  pending: Map<string, PendingRequest>;
}

export class ProxyTcpListener {
  private readonly opts: ProxyTcpListenerOptions;
  /** serviceName → client listesi (round-robin için) */
  private readonly clients = new Map<string, ConnectedClient[]>();
  /** Tüm bağlı clientlar (id → client) */
  private readonly clientsById = new Map<string, ConnectedClient>();
  private rrCounters = new Map<string, number>();

  constructor(opts: ProxyTcpListenerOptions) {
    this.opts = opts;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = tls.createServer({
        cert: this.opts.tlsCert,
        key: this.opts.tlsKey,
        ca: this.opts.tlsCa,
        requestCert: this.opts.requireClientCert ?? true,
        rejectUnauthorized: this.opts.requireClientCert ?? true,
      });

      server.on("secureConnection", (socket) => this.handleClient(socket));
      server.on("error", (err) =>
        console.error("[ProxyTcpListener] Sunucu hatası:", err),
      );
      server.on("tlsClientError", (err) =>
        console.warn("[ProxyTcpListener] TLS client hatası:", err.message),
      );

      server.listen(this.opts.port, this.opts.host, () => {
        console.log(
          `[ProxyTcpListener] TLS TCP dinleniyor: ${this.opts.host}:${this.opts.port}`,
        );
        resolve();
      });

      server.once("error", reject);
    });
  }

  // ─── İstek gönder ────────────────────────────────────────────────────────

  async sendRequest(
    serviceName: string,
    reqHeader: Omit<TcpHeader, "type" | "requestId">,
    body: Buffer,
    timeoutMs = 30_000,
  ): Promise<TcpMessage> {
    const client = this.pickClient(serviceName);
    if (!client) {
      throw new Error(
        `[ProxyTcpListener] Servis bulunamadı: "${serviceName}" (bağlı client yok)`,
      );
    }

    const requestId = generateId();
    const header: TcpHeader = { ...reqHeader, type: "REQUEST", requestId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(requestId);
        reject(
          new Error(
            `[ProxyTcpListener] Zaman aşımı: ${serviceName} (${timeoutMs}ms)`,
          ),
        );
      }, timeoutMs);

      client.pending.set(requestId, { resolve, reject, timer });
      client.socket.write(encodeMessage(header, body), (err) => {
        if (err) {
          client.pending.delete(requestId);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // ─── Bağlantı yönetimi ───────────────────────────────────────────────────

  /** Kalp atışı: her 30s'de PING gönder, 60s içinde PONG gelmezse kes */
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly PING_TIMEOUT_MS = 60_000;

  private handleClient(socket: tls.TLSSocket): void {
    const decoder = new FrameDecoder();
    let client: ConnectedClient | null = null;
    let lastPong = Date.now();

    // OS düzeyinde TCP keepalive – uzun sessizliklerde çekirdek probe gönderir
    socket.setKeepAlive(true, 15_000);

    // Uygulama düzeyinde heartbeat
    const pingInterval = setInterval(() => {
      if (Date.now() - lastPong > ProxyTcpListener.PING_TIMEOUT_MS) {
        console.warn(
          `[ProxyTcpListener] Heartbeat zaman aşımı${client ? ` ("${client.serviceName}" id=${client.id})` : ""}, bağlantı kapatılıyor.`,
        );
        clearInterval(pingInterval);
        socket.destroy();
        return;
      }
      if (!socket.destroyed) {
        socket.write(encodeMessage({ type: "PING" }));
      }
    }, ProxyTcpListener.PING_INTERVAL_MS);

    console.log(
      `[ProxyTcpListener] Yeni bağlantı: ${socket.remoteAddress}:${socket.remotePort}`,
    );

    socket.on("data", (data: Buffer) => {
      decoder.push(data, (msg) => {
        if (!client) {
          // İlk mesaj REGISTER olmalı
          if (msg.header.type === "REGISTER" && msg.header.serviceName) {
            client = this.registerClient(socket, msg.header.serviceName);
            socket.write(
              encodeMessage({
                type: "REGISTER_ACK",
                serviceName: client.serviceName,
              }),
            );
            console.log(
              `[ProxyTcpListener] Client kaydedildi: "${client.serviceName}" (id=${client.id})`,
            );
          } else {
            console.warn(
              "[ProxyTcpListener] İlk mesaj REGISTER değil, bağlantı kapatılıyor.",
            );
            clearInterval(pingInterval);
            socket.destroy();
          }
          return;
        }

        if (msg.header.type === "PONG") {
          lastPong = Date.now();
          return;
        }

        if (msg.header.type === "RESPONSE" && msg.header.requestId) {
          const pending = client!.pending.get(msg.header.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            client!.pending.delete(msg.header.requestId);
            pending.resolve(msg);
          }
        }
      });
    });

    socket.on("close", () => {
      clearInterval(pingInterval);
      if (client) {
        this.unregisterClient(client);
        console.log(
          `[ProxyTcpListener] Client ayrıldı: "${client.serviceName}" (id=${client.id})`,
        );
      }
    });

    socket.on("error", (err) => {
      console.error(
        `[ProxyTcpListener] Socket hatası${client ? ` (${client.serviceName})` : ""}:`,
        err.message,
      );
    });
  }

  private registerClient(
    socket: tls.TLSSocket,
    serviceName: string,
  ): ConnectedClient {
    const client: ConnectedClient = {
      id: generateId(),
      serviceName,
      socket,
      pending: new Map(),
    };
    this.clientsById.set(client.id, client);
    const list = this.clients.get(serviceName) ?? [];
    list.push(client);
    this.clients.set(serviceName, list);
    return client;
  }

  private unregisterClient(client: ConnectedClient): void {
    this.clientsById.delete(client.id);
    const list = this.clients.get(client.serviceName) ?? [];
    const idx = list.indexOf(client);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.clients.delete(client.serviceName);
    else this.clients.set(client.serviceName, list);

    // Bekleyen istekleri reddet
    for (const [, pending] of client.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `[ProxyTcpListener] Client bağlantısı koptu: "${client.serviceName}"`,
        ),
      );
    }
    client.pending.clear();
  }

  /** Round-robin client seçimi */
  private pickClient(serviceName: string): ConnectedClient | null {
    const list = this.clients.get(serviceName);
    if (!list || list.length === 0) return null;
    const counter = this.rrCounters.get(serviceName) ?? 0;
    const client = list[counter % list.length];
    this.rrCounters.set(serviceName, counter + 1);
    return client;
  }
}

// ─── Fabrika ─────────────────────────────────────────────────────────────────

export function buildProxyTcpListener(): ProxyTcpListener {
  const host = process.env.TCP_LISTEN_HOST ?? "0.0.0.0";
  const port = parseInt(process.env.TCP_LISTEN_PORT ?? "14400", 10);

  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  const caPath = process.env.TLS_CA;

  if (!certPath || !keyPath) {
    throw new Error(
      "TLS_CERT ve TLS_KEY env değişkenleri zorunludur (proxy TCP listener)",
    );
  }

  return new ProxyTcpListener({
    host,
    port,
    tlsCert: fs.readFileSync(certPath),
    tlsKey: fs.readFileSync(keyPath),
    tlsCa: caPath ? fs.readFileSync(caPath) : undefined,
  });
}
