import os
import sys
import socket
import webbrowser
import threading
import time
import uvicorn
from dotenv import load_dotenv

# Load .env if present
load_dotenv()

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))


def get_local_ip():
    """Detect local LAN/Wi-Fi IPv4 address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def open_browser():
    time.sleep(1.2)
    url = f"http://localhost:{PORT}"
    print(f"\n[PantryPulse] Opening application in your browser: {url}\n")
    webbrowser.open(url)


if __name__ == "__main__":
    local_ip = get_local_ip()
    print("=" * 65)
    print("  PantryPulse - Grocery Replenishment & Receipt Tracker")
    print("=" * 65)
    print(f"  * Local Computer:       http://localhost:{PORT}")
    print(f"  * Mobile Phone / Wi-Fi: http://{local_ip}:{PORT}")
    print("=" * 65)
    print(f"To open from your phone browser on the same Wi-Fi, navigate to:")
    print(f"  -> http://{local_ip}:{PORT}")
    print("=" * 65)
    print("Press Ctrl+C to stop the server.\n")

    # Launch browser on local machine in separate thread
    threading.Thread(target=open_browser, daemon=True).start()

    # Run FastAPI app on 0.0.0.0 so external devices on LAN/Wi-Fi can access it
    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=True,
        log_level="info"
    )

