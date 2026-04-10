// ─── Mesaj tipleri ───────────────────────────────────────────────────────────

export type MessageType =
  | "REGISTER"
  | "REGISTER_ACK"
  | "REQUEST"
  | "RESPONSE"
  | "PING"
  | "PONG";

export interface TcpHeader {
  type: MessageType;
  /** Proxy → Client ile Client → Proxy arasında istek eşleştirme */
  requestId?: string;
  /** Client'ın kaydettiği servis adı (REGISTER) */
  serviceName?: string;
  // ── REQUEST alanları ──
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  // ── RESPONSE alanları ──
  status?: number;
}

export interface TcpMessage {
  header: TcpHeader;
  /** Ham body baytları (text/JSON/binary fark etmez) */
  body: Buffer;
}

// ─── Wire encode ─────────────────────────────────────────────────────────────
// Format: [4-byte BE: header JSON length][header JSON bytes]
//         [4-byte BE: body length][raw body bytes]

export function encodeMessage(
  header: TcpHeader,
  body: Buffer = Buffer.alloc(0),
): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const headerLen = Buffer.allocUnsafe(4);
  headerLen.writeUInt32BE(headerBuf.length, 0);

  const bodyLen = Buffer.allocUnsafe(4);
  bodyLen.writeUInt32BE(body.length, 0);

  return Buffer.concat([headerLen, headerBuf, bodyLen, body]);
}

// ─── Wire decode (streaming accumulator) ─────────────────────────────────────

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Gelen veriyi besle; tam frame(ler) tamamlandıkça callback çağrılır. */
  push(data: Buffer, onMessage: (msg: TcpMessage) => void): void {
    this.buf = Buffer.concat([this.buf, data]);

    while (true) {
      // En az 4 byte header length prefix gerekiyor
      if (this.buf.length < 4) break;
      const headerLen = this.buf.readUInt32BE(0);

      // Header + 4 byte (body length) gerekiyor
      if (this.buf.length < 4 + headerLen + 4) break;
      const bodyLen = this.buf.readUInt32BE(4 + headerLen);

      // Body da tamam mı?
      const totalLen = 4 + headerLen + 4 + bodyLen;
      if (this.buf.length < totalLen) break;

      const headerJson = this.buf.subarray(4, 4 + headerLen).toString("utf8");
      const body = this.buf.subarray(4 + headerLen + 4, totalLen);

      let header: TcpHeader;
      try {
        header = JSON.parse(headerJson);
      } catch (e) {
        console.error(
          "[FrameDecoder] Geçersiz JSON header, bağlantı sıfırlanıyor:",
          e,
        );
        this.buf = Buffer.alloc(0);
        break;
      }

      onMessage({ header, body: Buffer.from(body) });
      this.buf = this.buf.subarray(totalLen);
    }
  }
}

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
