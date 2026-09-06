import json
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/process")
async def process_image(
    file: UploadFile = File(...),
    features: str = Form("{}")
):
    metadata = json.loads(features)
    print(f"\n[SERVER] Received sanitized image: {file.filename}")
    print(f"[SERVER] Local features parsed: {metadata.get('redactedElements', 0)} redacted elements")
    print(f"[SERVER] Candidates for action: {len(metadata.get('interactiveCandidates', []))}")

    # If interactive candidates were found, pick the first one's center as a demo action
    candidates = metadata.get("interactiveCandidates", [])
    if candidates:
        first = candidates[0]["bbox"] # [x, y, w, h]
        center_x = first[0] + first[2] // 2
        center_y = first[1] + first[3] // 2
        action = f"click({center_x}, {center_y})"
    else:
        action = "click(200, 200)"

    return {"action": action}