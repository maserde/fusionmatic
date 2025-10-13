#!/usr/bin/env python3
"""
UDM Client Monitor dengan Redis

Cek client count, update Redis, hit webhook kalo perlu.
Integrates dengan Redis system yang udah ada.
"""

import requests
import time
import logging
import json

# Config
# UDM API - cek client count aja
UDM_URL = "https://192.168.253.1/proxy/network/integration/v1/sites/88f7af54-98f8-306a-a1c7-c9349722b1f6/clients"
UDM_HEADERS = {"X-API-KEY": "t3WbySI7ZzYTsydRkCU_4sdYdt5AyWqu", "Accept": "application/json"}

# Webhook ke server lo sendiri (yang handle Peplink FusionHub di OpenStack)
# Ganti SERVER_NAME sesuai nama server FusionHub lo di OpenStack
SERVER_NAME = "tunnel-server"  # Default, atau ganti dengan nama server lo: fusionhub_hiu_office, dll
WEBHOOK_URL = f"http://localhost:8888/v1/webhooks/servers/{SERVER_NAME}/states"
THRESHOLD = 30
CHECK_INTERVAL = 300

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Redis client (pake requests ke Redis REST API atau simple file-based tracking)
def get_client_count():
    """Get UDM client count"""
    try:
        response = requests.get(UDM_URL, headers=UDM_HEADERS, verify=False, timeout=10)
        return response.json().get("totalCount", 0)
    except Exception as e:
        logging.error(f"Error getting client count: {e}")
        return 0

def check_existing_task():
    """
    Cek apakah webhook lagi ada task yang PROCESSING
    Simple approach: cek last webhook call time
    """
    try:
        # Simple file-based tracking instead of Redis
        with open("last_task.json", "r") as f:
            data = json.load(f)
            last_call = data.get("timestamp", 0)
            # Kalo last call kurang dari 2 menit yang lalu, masih processing
            if time.time() - last_call < 120:  # 2 minutes
                return data
        return None
    except:
        return None

def save_task_info(state):
    """Save task info ke file"""
    try:
        data = {
            "state": state,
            "timestamp": time.time(),
            "client_count": get_client_count()
        }
        with open("last_task.json", "w") as f:
            json.dump(data, f)
    except Exception as e:
        logging.error(f"Error saving task info: {e}")

def update_udm_data(count):
    """Update UDM client count via new endpoint"""
    try:
        logging.info(f"📊 Updating UDM data: {count} clients")
        response = requests.put(
            "http://localhost:8888/v1/webhooks/udm/clients",
            json={"clientCount": count},
            timeout=10
        )
        
        if response.status_code == 200:
            logging.info(f"✅ UDM data updated successfully")
        else:
            logging.error(f"❌ UDM update failed: HTTP {response.status_code}")
            
    except Exception as e:
        logging.error(f"❌ UDM update error: {e}")

def trigger_state_change(state):
    """Trigger state change via bash scripts"""
    
    # Cek existing task
    existing = check_existing_task()
    if existing and existing.get("state") == state:
        logging.info(f"⚠️ Task {state} baru aja dipanggil, skip...")
        return
    
    try:
        import subprocess
        
        script_name = "startup-tunnel.sh" if state == "UP" else "shutdown-tunnel.sh"
        script_path = f"scripts/{script_name}"
        
        logging.info(f"🚀 Executing bash script: {script_path}")
        
        # Set environment variables
        env = {
            "SERVER_NAME": SERVER_NAME,
            "API_HOST": "http://localhost:8888"
        }
        
        # Execute bash script
        result = subprocess.run(
            ["bash", script_path], 
            env=env,
            capture_output=True, 
            text=True, 
            timeout=60
        )
        
        if result.returncode == 0:
            logging.info(f"✅ Bash script success: {script_name}")
            logging.info(f"Output: {result.stdout}")
            save_task_info(state)  # Save info
        else:
            logging.error(f"❌ Bash script failed: {script_name}")
            logging.error(f"Error: {result.stderr}")
            
    except subprocess.TimeoutExpired:
        logging.error(f"❌ Bash script timeout: {script_name}")
    except Exception as e:
        logging.error(f"❌ Bash script error: {e}")

def main():
    logging.info("🚀 UDM Monitor dengan Redis integration started")
    logging.info(f"📊 Threshold: {THRESHOLD} clients")
    
    # Disable SSL warnings
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    
    last_state = None
    
    while True:
        try:
            count = get_client_count()
            logging.info(f"📊 Client count: {count}")
            
            # Update UDM data via new endpoint
            update_udm_data(count)
            
            # Logic dengan time check (opsional)
            current_hour = time.localtime().tm_hour
            is_business_hours = 6 <= current_hour < 18  # 6 AM - 6 PM
            
            if count > THRESHOLD and last_state != "UP":
                logging.info(f"🔼 {count} > {THRESHOLD} → UP")
                if not is_business_hours:
                    logging.info("⚠️ Outside business hours, but client demand is high - forcing UP")
                trigger_state_change("UP")
                last_state = "UP"
                
            elif count < THRESHOLD and last_state != "DOWN":
                logging.info(f"🔽 {count} < {THRESHOLD} → DOWN")
                trigger_state_change("DOWN")
                last_state = "DOWN"
                
            else:
                logging.info(f"⏸️ No change needed (current: {last_state}, hour: {current_hour})")
            
            # Log current status
            with open("udm_status.json", "w") as f:
                json.dump({
                    "client_count": count,
                    "threshold": THRESHOLD,
                    "last_state": last_state,
                    "timestamp": time.time(),
                    "last_check": time.strftime("%Y-%m-%d %H:%M:%S")
                }, f)
            
            time.sleep(CHECK_INTERVAL)
            
        except KeyboardInterrupt:
            logging.info("👋 Stopped by user")
            break
        except Exception as e:
            logging.error(f"💥 Error: {e}")
            time.sleep(60)

if __name__ == "__main__":
    main()