chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "REDACT_IMAGE") {
    handlePipeline(request.imageUri)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
let ortSession = null;

// Initialize ONNX Runtime Session (WASM / WebGPU)
async function loadOmniParserDetector() {
  if (ortSession) return ortSession;

  try {
    console.log("[OmniParser ONNX] Initializing runtime session...");
    // Set execution providers (fallback to WASM if WebGPU is unavailable)
    ort.env.wasm.numThreads = 2;
    ort.env.wasm.simd = true;

    // Load lightweight icon detector model
    // Note: If you have a local icon_detect.onnx in your extension folder, point directly to it
    const modelUrl = chrome.runtime.getURL("icon_detect.onnx");
    ortSession = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"]
    });
    console.log("[OmniParser ONNX] Icon detector loaded successfully!");
  } catch (err) {
    console.warn("[OmniParser ONNX] Model file not yet present or initialization deferred. Falling back to hybrid visual bounds:", err);
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

// 3. Screen Analysis, Local Redaction & Icon Grounding
async function analyzeAndRedact(imageUri) {
  return new Promise(async (resolve, reject) => {
    const session = await loadOmniParserDetector();

    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      const dpr = window.devicePixelRatio || 1;

      // --- Part A: Pure Vision-Based Icon Detection via ONNX Runtime ---
      let visionDetections = [];
      if (session) {
        try {
          visionDetections = await runYoloInference(session, canvas);
          console.log("[OmniParser ONNX] Vision detected icons:", visionDetections.length);
        } catch (inferenceErr) {
          console.error("[OmniParser ONNX] Inference error:", inferenceErr);
        }
      }

      // --- Part B: DOM Interactive Candidates ---
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
          elementFeatures.push({
            id: index,
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || "").trim().slice(0, 30),
            bbox: [
              Math.round(rect.left * dpr),
              Math.round(rect.top * dpr),
              Math.round(rect.width * dpr),
              Math.round(rect.height * dpr)
            ]
          });
        }
      });

      // --- Part C: Local Privacy Masking ---
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

      // Combine vision-detected icons with parsed bounding candidates
      const visualFeatures = {
        viewport: { width: canvas.width, height: canvas.height, dpr },
        redactedElements: redactedCount,
        visionIcons: visionDetections,
        interactiveCandidates: elementFeatures.slice(0, 25)
      };

      resolve({
        sanitizedDataUrl: canvas.toDataURL("image/jpeg", 0.6),
        visualFeatures
      });
    };

    img.onerror = () => reject(new Error("Failed to load image for visual analysis"));
    img.src = imageUri;
  });
}

// 4. Preprocessing & Tensor Generation for ONNX Runtime
async function runYoloInference(session, sourceCanvas) {
  const modelWidth = 640;
  const modelHeight = 640;

  // Resize to standard detector dimensions (640x640)
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = modelWidth;
  tempCanvas.height = modelHeight;
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.drawImage(sourceCanvas, 0, 0, modelWidth, modelHeight);

  const imgData = tempCtx.getImageData(0, 0, modelWidth, modelHeight).data;
  const [red, green, blue] = [[], [], []];

  // Normalize pixel values to 0.0 - 1.0 (CHW format)
  for (let i = 0; i < imgData.length; i += 4) {
    red.push(imgData[i] / 255.0);
    green.push(imgData[i + 1] / 255.0);
    blue.push(imgData[i + 2] / 255.0);
  }
  const inputTensor = new ort.Tensor("float32", new Float32Array([...red, ...green, ...blue]), [1, 3, 640, 640]);

  const feeds = {};
  feeds[session.inputNames[0]] = inputTensor;
  const results = await session.run(feeds);

  // Return raw detections
  return results[session.outputNames[0]].data.slice(0, 20);
}

// 5. Send Sanitized Image and Features to Backend
async function sendToServer(dataUrl, visualFeatures) {
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  formData.append("file", blob, "screen.jpg");
  formData.append("features", JSON.stringify(visualFeatures));

  const response = await fetch("http://localhost:8000/process", {
    method: "POST",
    body: formData
  });

  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return await response.json();
}

// 6. Action Execution Engine
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

  if (actionString.startsWith("scroll(")) {
    const match = actionString.match(/scroll\((\d+)\)/);
    if (match) {
      window.scrollBy({ top: parseInt(match[1], 10), behavior: "smooth" });
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
    return true; // Keep async channel open
  }
});

async function handlePipeline(imageUri) {
  // 1. Redact locally on off-screen canvas
  const sanitizedDataUrl = await redactSensitiveData(imageUri);

  // 2. Transmit sanitized context to backend
  const serverResponse = await sendToServer(sanitizedDataUrl);

  // 3. Execute the returned command
  if (serverResponse && serverResponse.action) {
    executeAction(serverResponse.action);
    return { status: "Action executed", action: serverResponse.action };
  }

  return { status: "No action returned" };
}

async function redactSensitiveData(imageUri) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      ctx.drawImage(img, 0, 0);

      const dpr = window.devicePixelRatio || 1;
      const sensitiveSelectors = [
        'input[type="password"]',
        'input[autocomplete*="cc-"]',
        'input[name*="cvv"]',
        'input[name*="card"]'
      ];
      const sensitiveElements = document.querySelectorAll(sensitiveSelectors.join(","));

      ctx.fillStyle = "#111111";
      sensitiveElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const pad = 4 * dpr;
        ctx.fillRect(
          rect.left * dpr - pad,
          rect.top * dpr - pad,
          rect.width * dpr + pad * 2,
          rect.height * dpr + pad * 2
        );
      });

      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = (err) => reject(new Error("Failed to load image for redaction"));
    img.src = imageUri;
  });
}

async function sendToServer(dataUrl) {
  // Convert DataURL to Blob to match FastAPI UploadFile
  const blob = await (await fetch(dataUrl)).blob();
  const formData = new FormData();
  formData.append("file", blob, "screen.jpg");

  const response = await fetch("http://localhost:8000/process", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  return await response.json();
}

function executeAction(actionString) {
  const dpr = window.devicePixelRatio || 1;

  // Pattern 1: click(x, y)
  if (actionString.startsWith("click(")) {
    const match = actionString.match(/click\((\d+),\s*(\d+)\)/);
    if (match) {
      // Map coordinates back to CSS viewport coordinates
      const targetX = parseInt(match[1], 10) / dpr;
      const targetY = parseInt(match[2], 10) / dpr;

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

  // Pattern 2: scroll(offsetY)
  if (actionString.startsWith("scroll(")) {
    const match = actionString.match(/scroll\((\d+)\)/);
    if (match) {
      window.scrollBy({ top: parseInt(match[1], 10), behavior: "smooth" });
    }
  }
}
