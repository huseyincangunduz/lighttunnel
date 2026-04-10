# Lighttunnel Proxy/Client

NAT arkasındaki sunucuları internete açmak için hafif bir ters proxy tüneli.  
Client sunucular **proxy'ye** TLS TCP ile outbound bağlanır; proxy gelen HTTP isteklerini ilgili client'a yönlendirir.

```
İnternet → [Proxy Server] ←─ TLS TCP ─── [Client Server] → localhost:PORT (backend)
```

---

## Çalıştırma

### 1. Sertifika Üret

```bash
bash generate_certs.sh
# certs/ dizinine ca.crt, server.crt/key, client.crt/key üretir
```

### 2. Proxy Sunucusunu Başlat

```bash
env $(cat proxy.env | grep -v '^#') node dist/proxy-server.js
```

### 3. Client Sunucuyu Başlat (her sunucu için ayrı ayrı)

```bash
env $(cat client-server.env | grep -v '^#') node dist/client-server.js
```

### 4. İstek At

```bash
curl http://<proxy-host>:12180/services/<SERVICE_NAME>/api/v1/foo
```

---

## Ortam Değişkenleri

### `proxy.env` — Proxy Sunucusu

| Değişken          | Varsayılan | Açıklama                                      |
| ----------------- | ---------- | --------------------------------------------- |
| `TCP_LISTEN_HOST` | `0.0.0.0`  | Client'ların bağlandığı TCP arayüzü           |
| `TCP_LISTEN_PORT` | `14400`    | Client'ların bağlandığı TCP portu             |
| `TLS_CERT`        | —          | Proxy'nin TLS sertifikası (`server.crt`)      |
| `TLS_KEY`         | —          | Proxy'nin TLS private key'i (`server.key`)    |
| `TLS_CA`          | —          | CA sertifikası — client doğrulama için (mTLS) |
| `PROXY_PORT`      | `4000`     | İnternete açık HTTP portu                     |

### `client-server.env` — Client Sunucusu

| Değişken         | Varsayılan  | Açıklama                                    |
| ---------------- | ----------- | ------------------------------------------- |
| `PROXY_HOST`     | `localhost` | Proxy sunucusunun adresi                    |
| `PROXY_TCP_PORT` | `14400`     | Proxy TCP portu                             |
| `TLS_CA`         | —           | CA sertifikası — proxy doğrulama için       |
| `TLS_CERT`       | —           | Client TLS sertifikası (mTLS için)          |
| `TLS_KEY`        | —           | Client TLS private key'i                    |
| `SERVICE_NAME`   | —           | Bu client'ın servis adı (URL'de kullanılır) |
| `BACKEND_URL`    | —           | İsteklerin iletileceği yerel HTTP adresi    |

---

## Protokol

```
[4-byte: header JSON uzunluğu][header JSON][4-byte: body uzunluğu][ham body bytes]
```

- Header → JSON (type, method, path, headers, status…)
- Body → ham `Buffer` (text / JSON / binary fark etmez, encoding yok)

Mesaj tipleri: `REGISTER` · `REGISTER_ACK` · `REQUEST` · `RESPONSE` · `PING` · `PONG`

---

## Derleme

```bash
npm install
npm run build   # dist/ altına derler
```
