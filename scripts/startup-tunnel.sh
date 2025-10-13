#!/bin/bash

SERVER_NAME="${SERVER_NAME:-tunnel-server}"
API_HOST="${API_HOST:-http://localhost:8888}"
ENDPOINT="/v1/webhooks/servers/${SERVER_NAME}/states"

echo "Starting server: ${SERVER_NAME}..."

# Get current client count from endpoint
client_count=$(curl -s "${API_HOST}/v1/webhooks/udm/count" || echo "0")

echo "Current UDM Clients: $client_count"

# Logic: only start if client count > 30
if [ "$client_count" -gt 30 ]; then
    echo "High usage ($client_count > 30) → Starting server UP"
    
    # Start the server
    curl -X PUT "${API_HOST}${ENDPOINT}" \
      -H "Content-Type: application/json" \
      -d '{"state": "UP"}' \
      -w "\nHTTP Status: %{http_code}\n"
    
    echo "Server startup request sent."
else
    echo "Low usage ($client_count <= 30) → Not starting server"
fi