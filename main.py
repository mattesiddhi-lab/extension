from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# 1. Allow all origins for extension traffic
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows chrome-extension:// origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. Accept the WebSocket connection explicitly
@app.websocket("/ws/agent")
async def websocket_agent_endpoint(websocket: WebSocket):
    # Explicitly accept handshake regardless of origin header
    await websocket.accept()
    print("[Server] Extension connected via WebSocket!")
    
    try:
        while True:
            data = await websocket.receive_text()
            print(f"[Server] Received: {data}")
            
            # Echo ACK or send test JSON action back to extension
            await websocket.send_json({
                "type": "STATUS",
                "message": "Payload received successfully"
            })
    except WebSocketDisconnect:
        print("[Server] Extension disconnected.")