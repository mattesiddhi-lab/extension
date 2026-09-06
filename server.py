from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

app = FastAPI(title="VLM Vision Agent Server")

# Define the incoming structure from the Chrome extension
class ScreenPayload(BaseModel):
    userRequest: str
    sanitizedImage: str  # Base64 PNG image string
    domContext: Dict[str, Any]
    visualFeatures: Dict[str, Any]

@app.post("/process-screen")
async def process_screen(payload: ScreenPayload):
    """
    This endpoint receives the redacted screenshot and DOM context 
    from the Chrome Extension and passes it to the VLM.
    """
    try:
        # 1. Base64 Redacted Image (Ready for OpenAI / Anthropic / Gemini vision input)
        base64_image = payload.sanitizedImage
        
        # 2. Interactive DOM elements
        interactive_elements = payload.domContext.get("interactiveElements", [])
        
        print(f"Received user request: {payload.userRequest}")
        print(f"Interactive elements detected: {len(interactive_elements)}")

        # --- VLM INTEGRATION PLACEHOLDER ---
        # Your VLM team puts their API call here (e.g. OpenAI / Claude / Gemini)
        # Pass `base64_image` + `interactive_elements` into the prompt
        
        # Example structured action returned by the model:
        recommended_action = {
            "action": "click",
            "elementId": 0  # Targets element data-privacy-agent-id="0"
        }
        # -----------------------------------

        return {
            "status": "SUCCESS",
            "action": recommended_action
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)