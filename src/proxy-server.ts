import Fastify from "fastify";
import { buildProxyTcpListener } from "./tcp/proxy-listener";
import { CacheManagerService } from "./cache-manager/cache-manager.service";
import { ClientResponse } from "./common";

// ProxyServer REST isteklerini kabul eder ve TCP üzerinden ilgili
// ClientServer'a yönlendirerek yanıtı istemciye döner.
export class ProxyServer {
  readonly cache = new CacheManagerService();
  readonly cacheDurationPerPath: Record<string, number> = {
    // Örnek: "/services/my-service/some-path": 30000, // 30 saniye
  };
  async start(port: number): Promise<void> {
    const tcpListener = buildProxyTcpListener();
    await tcpListener.listen();

    const fastify = Fastify({ logger: true });

    // Tüm HTTP metodları için /services/:serviceName/* yolunu dinle
    const methods = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ] as const;

    for (const method of methods) {
      fastify.route({
        method,
        url: "/services/:serviceName/*",
        handler: async (request, reply) => {
          const { serviceName } = request.params as { serviceName: string };
          // request.raw.url kullanıyoruz — Fastify params'ı decode eder, bu yüzden
          // %20 gibi encode'lu karakterleri korumak için ham URL'den prefix kesiyoruz.
          const rawUrl = request.raw.url ?? request.url;
          const prefix = `/services/${serviceName}`;
          const path = rawUrl.startsWith(prefix)
            ? rawUrl.slice(prefix.length) || "/"
            : "/";
          // Hop-by-hop header'larını filtrele
          const rawHeaders = request.headers as Record<
            string,
            string | string[] | undefined
          >;

          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }

          // İstek gövdesini ham Buffer olarak al
          let bodyBuf: Buffer = Buffer.alloc(0);
          if (request.body !== undefined && request.body !== null) {
            if (Buffer.isBuffer(request.body)) {
              bodyBuf = request.body;
            } else if (typeof request.body === "string") {
              bodyBuf = Buffer.from(request.body, "utf8");
            } else {
              bodyBuf = Buffer.from(JSON.stringify(request.body), "utf8");
            }
          }

          console.log(
            `[ProxyServer] ${method} /services/${serviceName}${path}`,
          );
          const authorzation = headers["authorization"] ?? headers["Authorization"] ?? "";
          const getMethodCacheKey = `${serviceName}:${path} (auth=${authorzation})`;
          if (request.method === "GET") {
            // TODO: API anahtarı ve eşsiz header anahtarlarına göre ekstra cache key parçaları eklenebilir. Kullanıcıya özel isteklerde cache kullanmak riskli olabilir, bu yüzden dikkatli olunmalı.
            const resp = await this.cache.getOrCallAsync(
              getMethodCacheKey,
              async () => await this.handleRequest(
                serviceName,
                request,
                reply,
                path,
                headers,
                bodyBuf,
                tcpListener,
              ),
              // Eğer json tarzı bir şeyse 1 saniye, yoksa 15 saniye önbellekte tut, her GET isteğinde süre uzatılır.
              { livetime: this.cacheDurationPerPath[path] ?? 15000, livetimeExtending: "ON_GET" },
            );

            if (resp.status >= 400) {
              console.warn(`[ProxyServer] Cache'den dönen yanıt hatalı görünüyor, cache temizleniyor: ${getMethodCacheKey}`);
              this.cache.invalidateStr(getMethodCacheKey);
            }

            if (resp !== null && this.cacheDurationPerPath[path] == null) {
              console.log(`[ProxyServer] Cache'den yanıt dönülüyor: ${getMethodCacheKey}`);
              const responseType = resp.bodyType ?? null;
              if (responseType != null && (responseType === "application/json" || responseType.startsWith("text/"))) {
                console.log(`[ProxyServer] Cache'den dönen yanıtın içeriği: ${resp.body.toString("utf8")}`);
                this.cacheDurationPerPath[path] = 1000; // Eğer önceden süre tanımlanmamışsa, json/text yanıtlar için 1 saniye önbellekte tut. Sürekli takip edilen backend responseları için önemli olabilir...
              }

            }


            return await this.respondWith(resp, reply);
          }

          if (request.method !== "GET") {
            // Eğer gelen path için farklı bir istek varsa ve o path'te bir get işlemi varsa cache'i temizle
            if (this.cache.has(getMethodCacheKey)) {
              console.log(
                `[ProxyServer] ${method} isteği nedeniyle cache temizleniyor: ${getMethodCacheKey}`,
              );
              this.cache.invalidateStr(getMethodCacheKey);
            }
          }

          const requestResult = await this.handleRequest(
            serviceName,
            request,
            reply,
            path,
            headers,
            bodyBuf,
            tcpListener,
          );

          return await this.respondWith(requestResult, reply);
        },
      });
    }


    // Ham body için content-type parser
    fastify.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => {
        done(null, body);
      },
    );

    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`[ProxyServer] HTTP dinleniyor: 0.0.0.0:${port}`);
  }

  async respondWith(response: ClientResponse, reply: any) {
    reply.status(response.status);
    reply.headers(response.headers);
    if (response.bodyType) reply.type(response.bodyType);
    return reply.send(response.body);
  }

  async handleRequest(
    serviceName: string,
    request: any,
    reply: any,
    path: string,
    headers: Record<string, string>,
    bodyBuf: Buffer,
    tcpListener: any,
  ): Promise<ClientResponse> {
    try {
      const tcpRes = await tcpListener.sendRequest(
        serviceName,
        { method: request.method, path, headers },
        bodyBuf,
      );

      const resHeader = tcpRes.header;
      reply.status(resHeader.status ?? 200);

          if (resHeader.headers) {
        for (const [k, v] of Object.entries(resHeader.headers)) {
          const lower = k.toLowerCase();
          // Hop-by-hop ve Fastify'ın yönettiği header'ları atla
          if (
            [
              "transfer-encoding",
              "connection",
              "content-encoding",
              "content-length",
            ].includes(lower)
          )
            continue;
          reply.header(k, v);
        }
      }

      console.log(
        `[ProxyServer] Yanıt alındı: "${serviceName}" → ${resHeader.status}, body=${tcpRes.body.length} byte`,
      );
      return {
        status: resHeader.status ?? 200,
        headers: resHeader.headers ?? {},
        body: tcpRes.body,
        bodyType: tcpRes.bodyType,
      };
    } catch (err) {
      console.error(
        `[ProxyServer] İstek başarısız ("${serviceName}"):`,
        err,
      );
      return {
        status: 502,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: "Bad Gateway", message: String(err) })),
        bodyType: "application/json",
      };
    }
  }
}



// ─── Giriş noktası ───────────────────────────────────────────────────────────
if (require.main === module) {
  const port = parseInt(process.env.PROXY_PORT ?? "4000", 10);
  const server = new ProxyServer();

  server.start(port).catch((err) => {
    console.error("[ProxyServer] Fatal:", err);
    process.exit(1);
  });
}
