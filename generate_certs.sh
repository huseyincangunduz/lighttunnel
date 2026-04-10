#!/bin/bash

# Generate SSL certificates for Engine5Go
# This script creates a CA, server certificate, and optionally client certificates

set -e

CERT_DIR="./certs"
DOMAIN="localhost"
DAYS=365

# Extra IP addresses to include in the server certificate SAN
# Usage: EXTRA_IPS="192.168.1.10 10.0.0.5" ./generate_certs.sh
IFS=' ' read -ra EXTRA_IPS <<< "${EXTRA_IPS:-}"

# Create certificates directory
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

echo "🔐 Generating SSL certificates for Engine5Go..."

# Generate CA private key
echo "📝 Generating CA private key..."
openssl genrsa -out ca.key 4096

# Generate CA certificate
echo "📝 Generating CA certificate..."
openssl req -new -x509 -days $DAYS -key ca.key -out ca.crt -subj "/C=TR/ST=Istanbul/L=Istanbul/O=Engine5Go/OU=CA/CN=Engine5Go-CA"

# Generate server private key
echo "📝 Generating server private key..."
openssl genrsa -out server.key 4096

# Generate server certificate signing request
echo "📝 Generating server certificate request..."
openssl req -new -key server.key -out server.csr -subj "/C=TR/ST=Istanbul/L=Istanbul/O=Engine5Go/OU=Server/CN=$DOMAIN"

# Create server certificate extensions
cat > server.ext << EOF
[v3_req]
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

# Append any extra IPs to the SAN section
IP_INDEX=3
for EXTRA_IP in "${EXTRA_IPS[@]}"; do
    echo "IP.$IP_INDEX = $EXTRA_IP" >> server.ext
    (( IP_INDEX++ ))
done

# Generate server certificate signed by CA
echo "📝 Generating server certificate..."
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days $DAYS -extensions v3_req -extfile server.ext

# Generate client private key (optional, for mutual TLS)
echo "📝 Generating client private key..."
openssl genrsa -out client.key 4096

# Generate client certificate signing request
echo "📝 Generating client certificate request..."
openssl req -new -key client.key -out client.csr -subj "/C=TR/ST=Istanbul/L=Istanbul/O=Engine5Go/OU=Client/CN=engine5go-client"

# Generate client certificate signed by CA
echo "📝 Generating client certificate..."
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days $DAYS

# Set proper permissions
chmod 600 *.key
chmod 644 *.crt

# Clean up CSR files
rm server.csr client.csr server.ext

echo "✅ SSL certificates generated successfully!"
echo ""
echo "📁 Generated files:"
echo "  - ca.crt        (Certificate Authority)"
echo "  - ca.key        (CA Private Key)"
echo "  - server.crt    (Server Certificate)"
echo "  - server.key    (Server Private Key)"
echo "  - client.crt    (Client Certificate - for mutual TLS)"
echo "  - client.key    (Client Private Key - for mutual TLS)"
echo ""
echo "🚀 To run Engine5Go with TLS:"
echo "  export TLS_CERT_FILE=./certs/server.crt"
echo "  export TLS_KEY_FILE=./certs/server.key"
echo "  export TLS_CA_FILE=./certs/ca.crt"
echo "  export ENABLE_TLS=true"
echo "  export TLS_REQUIRE_CLIENT_AUTH=false  # Set to true for mutual TLS"
echo ""
echo "⚠️  Remember to keep private keys secure and never commit them to version control!"