import { fetch } from "undici";
import { buildClientTcpConnection } from "./tcp/client-connection";
import { TcpHeader } from "./tcp/protocol";
import { exec } from "child_process";

// ClientServer proxy'den gelen TCP isteklerini yerel bir HTTP backend'e ileterek yanıtı döner.
export class ClientServer {
  private readonly serviceName: string;
  private readonly backendUrl: string;

  constructor(serviceName: string, backendUrl: string) {
    this.serviceName = serviceName;
    this.backendUrl = backendUrl.replace(/\/$/, "");
  }

  start(): void {
    const conn = buildClientTcpConnection(this.serviceName);
    conn.start((header, body) => this.handleProxyRequest(header, body));
    console.log(`[ClientServer] Servis: "${this.serviceName}"`);
    console.log(`[ClientServer] Backend: ${this.backendUrl}`);
  }

  private async handleProxyRequest(
    header: TcpHeader,
    body: Buffer,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }> {
    const url = `${this.backendUrl}${header.path ?? "/"}`;
    console.log(`[ClientServer] ${header.method} ${url}`);

    const method = header.method ?? "GET";
    const hasBody =
      body.length > 0 &&
      !["GET", "HEAD", "DELETE"].includes(method.toUpperCase());

    // Conditional cache header'larını temizle (browser cache yokken 304 gelirse body boş kalır)
    const CONDITIONAL_HEADERS = [
      "if-none-match",
      "if-modified-since",
      "if-match",
      "if-unmodified-since",
      "if-range",
    ];
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(header.headers ?? {})) {
      if (!CONDITIONAL_HEADERS.includes(k.toLowerCase())) {
        forwardHeaders[k] = v;
      }
    }

    const response = await fetch(url, {
      method,
      headers: forwardHeaders,
      body: hasBody ? body : undefined,
    });

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    const resBody = Buffer.from(await response.arrayBuffer());

    return {
      status: response.status,
      headers: resHeaders,
      body: resBody,
    };
  }
}

// ─── Giriş noktası ───────────────────────────────────────────────────────────
if (require.main === module) {
  const serviceName = process.env.SERVICE_NAME;
  const backendUrl = process.env.BACKEND_URL;

  if (!serviceName) {
    console.error("SERVICE_NAME env değişkeni zorunludur");
    process.exit(1);
  }
  if (!backendUrl) {
    console.error("BACKEND_URL env değişkeni zorunludur");
    process.exit(1);
  }

  const server = new ClientServer(serviceName, backendUrl);
  server.start();
}
