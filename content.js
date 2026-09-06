let ortSession = null;

// Initialize ONNX Runtime Session (with graceful fallback)
async function loadOmniParserDetector() {
  if (ortSession) return ortSession;
  try {
    if (typeof ort !== "undefined") {
      ort.env.wasm.numThreads = 2;
      ort.env.wasm.simd = true;
      const modelUrl = chrome.runtime.getURL("icon_detect.onnx");
      ortSession = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"]
      });
      console.log("[OmniParser ONNX] Loaded successfully");
    }
  } catch (err) {
    console.warn("[OmniParser ONNX] Model initialization deferred:", err);
  }
  return ortSession;
}

// 1. Extension Runtime Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "REDACT_IMAGE") {
    handlePipeline(request.imageUri)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep async response channel open
  }
});

// 2. Main Execution Pipeline
async function handlePipeline(imageUri) {
  const { sanitizedDataUrl, visualFeatures } = await analyzeAndRedact(imageUri);
  const serverResponse = await sendToServer(sanitizedDataUrl, visualFeatures);

  if (serverResponse && serverResponse.action) {
    executeAction(serverResponse.action);
  }

  return {
    status: "Success",
    action: serverResponse ? serverResponse.action : null,
    visualFeatures: visualFeatures,
    sanitizedImage: sanitizedDataUrl
  };
}

// 3. Screen Analysis, Local Redaction & OmniParser Bounding Boxes
async function analyzeAndRedact(imageUri) {
  return new Promise(async (resolve, reject) => {
    try {
      await loadOmniParserDetector();
      const img = new Image();

      img.onload = async () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);

        const dpr = window.devicePixelRatio || 1;

        // --- Part A: OmniParser Visual Grounding & Bounding Boxes ---
        const interactiveSelectors = [
          "button",
          "a[href]",
          'input[type="submit"]',
          'input[type="button"]',
          '[role="button"]'
        ];
        const interactiveElements = document.querySelectorAll(interactiveSelectors.join(","));

        const elementFeatures = [];
        interactiveElements.forEach((el, index) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0) {
            const bbox = [
              Math.round(rect.left * dpr),
              Math.round(rect.top * dpr),
              Math.round(rect.width * dpr),
              Math.round(rect.height * dpr)
            ];

            elementFeatures.push({
              id: index,
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.value || "").trim().slice(0, 30),
              bbox: bbox
            });

            // 1. Draw Green Bounding Box
            ctx.strokeStyle = "#10b981";
            ctx.lineWidth = 2 * dpr;
            ctx.strokeRect(bbox[0], bbox[1], bbox[2], bbox[3]);

            // 2. Draw Numeric Badge [0], [1], [2] (OmniParser Style)
            const badgeWidth = 22 * dpr;
            const badgeHeight = 15 * dpr;
            ctx.fillStyle = "#10b981";
            ctx.fillRect(bbox[0], Math.max(0, bbox[1] - badgeHeight), badgeWidth, badgeHeight);

            // 3. Draw Badge Text
            ctx.fillStyle = "#ffffff";
            ctx.font = `bold ${10 * dpr}px sans-serif`;
            ctx.fillText(`${index}`, bbox[0] + 3 * dpr, Math.max(11 * dpr, bbox[1] - 3 * dpr));
          }
        });

        // --- Part B: Privacy Redaction (Solid Blackout Over Credentials) ---
        const sensitiveSelectors = [
          'input[type="password"]',
          'input[autocomplete*="cc-"]',
          'input[name*="cvv"]',
          'input[name*="card"]'
        ];
        const sensitiveElements = document.querySelectorAll(sensitiveSelectors.join(","));

        ctx.fillStyle = "#0a0a0a";
        let redactedCount = 0;
        sensitiveElements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          const pad = 4 * dpr;
          ctx.fillRect(
            rect.left * dpr - pad,
            rect.top * dpr - pad,
            rect.width * dpr + pad * 2,
            rect.height * dpr + pad * 2
          );
          redactedCount++;
        });

        const visualFeatures = {
          viewport: { width: canvas.width, height: canvas.height, dpr },
          redactedElements: redactedCount,
          interactiveCandidates: elementFeatures.slice(0, 25)
        };

        resolve({
          sanitizedDataUrl: canvas.toDataURL("image/jpeg", 0.6),
          visualFeatures
        });
      };

      img.onerror = () => reject(new Error("Failed to load image for visual analysis"));
      img.src = imageUri;
    } catch (err) {
      reject(err);
    }
  });
}

// 4. Send Sanitized Image and Features to Backend
async function sendToServer(dataUrl, visualFeatures) {
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  formData.append("file", blob, "screen.jpg");
  formData.append("features", JSON.stringify(visualFeatures));

  const response = await fetch("http://127.0.0.1:8000/process", {
    method: "POST",
    body: formData
  });

  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return await response.json();
}

// 5. Action Execution Engine
function executeAction(actionString) {
  const dpr = window.devicePixelRatio || 1;

  if (actionString.startsWith("click(")) {
    const match = actionString.match(/click\((\d+),\s*(\d+)\)/);
    if (match) {
      const targetX = parseInt(match[1], 10) / dpr;
      const targetY = parseInt(match[2], 10) / dpr;

      showClickIndicator(targetX, targetY);

      const element = document.elementFromPoint(targetX, targetY);
      if (element) {
        element.focus();
        element.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: targetX,
          clientY: targetY
        }));
        console.log(`[Agent] Clicked element at (${targetX}, ${targetY}):`, element);
      }
    }
  }
}

function showClickIndicator(x, y) {
  const marker = document.createElement("div");
  marker.style.position = "fixed";
  marker.style.left = `${x - 12}px`;
  marker.style.top = `${y - 12}px`;
  marker.style.width = "24px";
  marker.style.height = "24px";
  marker.style.borderRadius = "50%";
  marker.style.backgroundColor = "rgba(239, 68, 68, 0.7)";
  marker.style.border = "2px solid #b91c1c";
  marker.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.8)";
  marker.style.pointerEvents = "none";
  marker.style.zIndex = "2147483647";
  document.body.appendChild(marker);
  setTimeout(() => marker.remove(), 450);
}