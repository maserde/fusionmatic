#!/usr/bin/env python3
"""
Simple UDM Client Counter
Cuma ambil total client count dan kirim ke endpoint
"""

import requests
import json
import time
import logging

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

# Config
UDM_URL = "https://192.168.253.1/proxy/network/integration/v1/sites/88f7af54-98f8-306a-a1c7-c9349722b1f6/clients"
UDM_HEADERS = {"X-API-KEY": "t3WbySI7ZzYTsydRkCU_4sdYdt5AyWqu", "Accept": "application/json"}
WEBHOOK_URL = "http://localhost:8888/v1/webhooks/udm/clients"

def get_client_count():
    """Get UDM client count"""
    try:
        response = requests.get(UDM_URL, headers=UDM_HEADERS, verify=False, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        # Count array length
        client_count = len(data) if isinstance(data, list) else data.get('count', 0)
        
        logging.info(f"📊 UDM Client count: {client_count}")
        return client_count
        
    except Exception as e:
        logging.error(f"❌ Failed to get UDM client count: {e}")
        return 0

def send_to_endpoint(client_count):
    """Send client count to webhook endpoint"""
    try:
        payload = {"clientCount": client_count}
        response = requests.put(WEBHOOK_URL, json=payload, timeout=5)
        response.raise_for_status()
        
        logging.info(f"✅ Sent client count to endpoint: {client_count}")
        return True
        
    except Exception as e:
        logging.error(f"❌ Failed to send to endpoint: {e}")
        return False

def main():
    """Main function - run once to get and send client count"""
    logging.info("🚀 Getting UDM client count...")
    
    client_count = get_client_count()
    if client_count is not None:
        send_to_endpoint(client_count)
    
    logging.info("✅ Done")

if __name__ == "__main__":
    main()