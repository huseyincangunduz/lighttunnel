// Proxy katmanında taşınan tip sözleşmeleri

export interface ProxyRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** İstek gövdesi — ham Buffer olarak taşınır */
  body?: Buffer;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  /** Yanıt gövdesi — ham Buffer olarak taşınır */
  body: Buffer;
  bodyType?: string;

}

export interface ClientResponse {
  status: number;
  headers: Record<string, string>;
  /** Yanıt gövdesi — ham Buffer olarak taşınır */
  body: Buffer;
  bodyType?: string;
}