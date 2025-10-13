#!/bin/bash

SERVER_NAME="${SERVER_NAME:-tunnel-server}"
API_HOST="${API_HOST:-http://localhost:8888}"
ENDPOINT="/v1/webhooks/servers/${SERVER_NAME}/states"

echo "Checking if server should shutdown..."

# Get current client count from endpoint
client_count=$(curl -s "${API_HOST}/v1/webhooks/udm/count" || echo "0")

echo "Current UDM Clients: $client_count"

# Logic: only shutdown if client count < 30
if [ "$client_count" -lt 30 ]; then
    echo "Low usage ($client_count < 30) → Shutting down server"
    
    # Stop the server
    curl -X PUT "${API_HOST}${ENDPOINT}" \
      -H "Content-Type: application/json" \
      -d '{"state": "DOWN"}' \
      -w "\nHTTP Status: %{http_code}\n"
    
    echo "Server shutdown request sent."
else
    echo "High usage ($client_count >= 30) → Keeping server UP"
fi