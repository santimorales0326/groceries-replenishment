import os
import sys
import webbrowser
import threading
import time
import uvicorn
from dotenv import load_dotenv

# Load .env if present
load_dotenv()

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))


def open_browser():
    time.sleep(1.2)
    url = f"http://{HOST}:{PORT}"
    print(f"\n[PantryPulse] Opening application in your browser: {url}\n")
    webbrowser.open(url)


if __name__ == "__main__":
    print("=" * 60)
    print("  PantryPulse - Grocery Replenishment & Receipt Tracker")
    print("=" * 60)
    print(f"Server starting on http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop the server.\n")

    # Launch browser in separate thread
    threading.Thread(target=open_browser, daemon=True).start()

    # Run FastAPI app with hot reload enabled
    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        reload=True,
        log_level="info"
    )
