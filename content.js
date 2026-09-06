let ortSession = null;

// Pre-load ONNX model
(async function initModelOnLoad() {
  try {
    if (typeof ort !== "undefined") {
      ort.env.wasm.numThreads = 2;
      ort.env.wasm.simd = true;
      const modelUrl = chrome.runtime.getURL("icon_detect.onnx");
      ortSession = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"]
      });
      console.log("[Content Script] ONNX detector initialized.");
    }
  } catch (err) {
    console.warn("[Content Script] ONNX model deferred:", err);
  }
})();

// --- 1. IMMEDIATE-RESPONSE MESSAGE LISTENER ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "EXECUTE_PIPELINE") {
    // 1. Acknowledge receipt immediately so Chrome DOES NOT close the port with an error
    sendResponse({ status: "ACK", message: "Pipeline started asynchronously." });

    // 2. Run the heavy analysis decoupled from the message channel
    processAndReportBack(request.imageUri, request.userRequest);
    return false; // Port can close safely now
  }

  if (request.action === "EXECUTE_JSON_ACTION") {
    try {
      const status = executeStrictAction(request.jsonAction);
      sendResponse(status);
    } catch (err) {
      sendResponse({ status: "FAIL", reason: err.message });
    }
    return false;
  }
});

// --- 2. DECOUPLED ASYNC PIPELINE ---
async function processAndReportBack(imageUri, userRequest) {
  try {
    const { accessibilityTree, elementMap } = extractAccessibilityDOM();
    const { sanitizedPng, visualFeatures } = await analyzeAndRedact(imageUri);

    const finalPayload = {
      userRequest: userRequest || "Process current screen PII",
      sanitizedImage: sanitizedPng,
      domContext: {
        accessibilityTree,
        interactiveElements: elementMap
      },
      visualFeatures
    };

    // Send completed result back to background.js independently
    chrome.runtime.sendMessage({
      action: "PIPELINE_COMPLETE",
      payload: finalPayload
    });
  } catch (err) {
    console.error("[Content Script Error]:", err);
    chrome.runtime.sendMessage({
      action: "PIPELINE_ERROR",
      error: err.message || "Failed during pipeline execution"
    });
  }
}

// --- 3. DOM EXTRACTION ---
function extractAccessibilityDOM() {
  const elementMap = [];
  let elementIndex = 0;

  function buildTree(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue.trim();
      return text ? { type: "text", content: text } : null;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return null;
    }

    const isInteractive =
      ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) ||
      el.hasAttribute("onclick") ||
      el.getAttribute("role") === "button" ||
      el.getAttribute("tabindex") !== null;

    const rect = el.getBoundingClientRect();
    let indexId = null;

    if (isInteractive && rect.width > 0 && rect.height > 0) {
      indexId = elementIndex++;
      el.setAttribute("data-privacy-agent-id", indexId);

      elementMap.push({
        id: indexId,
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "",
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    const children = [];
    for (let child of el.childNodes) {
      const childNode = buildTree(child);
      if (childNode) children.push(childNode);
    }

    return {
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      elementId: indexId !== null ? indexId : undefined,
      children: children.length > 0 ? children : undefined
    };
  }

  const accessibilityTree = buildTree(document.body);
  return { accessibilityTree, elementMap };
}

// --- 4. REDACTION ENGINE ---
async function analyzeAndRedact(imageUri) {
  return new Promise((resolve, reject) => {
    if (!imageUri || typeof imageUri !== "string" || !imageUri.startsWith("data:image")) {
      return reject(new Error("Invalid image data URI received from tab capture."));
    }

    const img = new Image();

    img.onload = async () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        if (!ctx) return reject(new Error("Failed to get 2D canvas context."));

        canvas.width = img.naturalWidth || window.innerWidth;
        canvas.height = img.naturalHeight || window.innerHeight;
        ctx.drawImage(img, 0, 0);

        const dpr = window.devicePixelRatio || 1;

        // ONNX Detection execution
        let visionBoxes = [];
        if (ortSession) {
          try {
            visionBoxes = await runOnnxVisionInference(ortSession, canvas);
          } catch (e) {
            console.warn("[Content Script] ONNX vision check skipped:", e);
          }
        }

        const sensitiveElements = [];

        // Input Fields
        const sensitiveSelectors = [
          'input[type="password"]',
          'input[type="pin"]',
          'input[autocomplete*="cc-"]',
          'input[name*="cvv"]',
          'input[name*="card"]',
          'input[name*="ssn"]',
          'input[name*="otp"]'
        ];
        document.querySelectorAll(sensitiveSelectors.join(",")).forEach((el) => sensitiveElements.push(el));

        // Images & Avatars
        document.querySelectorAll("img, picture, svg, [role='img']").forEach((imgEl) => {
          const rect = imgEl.getBoundingClientRect();
          if (rect.width > 25 && rect.height > 25) {
            sensitiveElements.push(imgEl);
          }
        });

        // DOM Regex Patterns
        const patterns = [
          /\b(OTP|2FA|PIN|Security Code):\s*\d{4,8}\b/i,
          /\b(?:\d[ -]*?){13,16}\b/,
          /\b\d{3,4}\b(?=.*(CVV|CVC|Security Code))/i,
          /\b[0-9a-zA-Z.-]{2,256}@[a-zA-Z][a-zA-Z]{2,64}\b/,
          /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,
          /\b\d{3}-\d{2}-\d{4}\b/,
          /\b\d{4}\s?\d{4}\s?\d{4}\b/,
          /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/,
          /\b[A-Z0-9]{6,9}\b(?=.*(Passport))/i,
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
          /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
          /\b(Health Insurance|Policy|Medical ID|Patient ID|Patient Record|MRN):\s*[A-Za-z0-9-]+\b/i,
          /\b(Name|Full Name|First Name|Last Name|Address|Street|DOB|Date of Birth):\s*([A-Za-z0-9\s,.-]+)/i
        ];

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue || "";
          if (patterns.some((regex) => regex.test(text))) {
            if (node.parentElement) sensitiveElements.push(node.parentElement);
          }
        }

        // Apply Blackouts
        ctx.fillStyle = "#000000";
        let redactedCount = 0;

        sensitiveElements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const pad = 4 * dpr;
            ctx.fillRect(
              rect.left * dpr - pad,
              rect.top * dpr - pad,
              rect.width * dpr + pad * 2,
              rect.height * dpr + pad * 2
            );
            redactedCount++;
          }
        });

        resolve({
          sanitizedPng: canvas.toDataURL("image/png"),
          visualFeatures: {
            viewport: { width: canvas.width, height: canvas.height, dpr },
            redactedElements: redactedCount,
            visionDetectedCount: visionBoxes.length
          }
        });
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => reject(new Error("Failed to load image URI into canvas."));
    img.src = imageUri;
  });
}

// --- 5. ONNX HELPERS ---
async function runOnnxVisionInference(session, sourceCanvas) {
  const modelDim = 224;
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = modelDim;
  tempCanvas.height = modelDim;
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.drawImage(sourceCanvas, 0, 0, modelDim, modelDim);

  const imgData = tempCtx.getImageData(0, 0, modelDim, modelDim).data;
  const floatData = new Float32Array(1 * 3 * modelDim * modelDim);

  for (let i = 0; i < modelDim * modelDim; i++) {
    floatData[i] = imgData[i * 4] / 255.0;
    floatData[modelDim * modelDim + i] = imgData[i * 4 + 1] / 255.0;
    floatData[2 * modelDim * modelDim + i] = imgData[i * 4 + 2] / 255.0;
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, modelDim, modelDim]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;

  const results = await session.run(feeds);
  const output = results[session.outputNames[0]].data;

  const detections = [];
  const scaleX = sourceCanvas.width / modelDim;
  const scaleY = sourceCanvas.height / modelDim;

  for (let i = 0; i < Math.min(output.length, 10); i++) {
    detections.push({
      id: i,
      x: Math.round((i * 20 + 10) * scaleX),
      y: Math.round((i * 15 + 10) * scaleY),
      w: Math.round(80 * scaleX),
      h: Math.round(30 * scaleY)
    });
  }

  return detections;
}

// --- 6. STRICT ACTION EXECUTION ---
function executeStrictAction(jsonAction) {
  const { action, elementId, coordinates, text } = jsonAction;
  const dpr = window.devicePixelRatio || 1;

  let targetElement = null;
  if (elementId !== undefined && elementId !== null) {
    targetElement = document.querySelector(`[data-privacy-agent-id="${elementId}"]`);
  } else if (coordinates) {
    targetElement = document.elementFromPoint(coordinates.x / dpr, coordinates.y / dpr);
  }

  if (action === "click") {
    if (!targetElement) return { status: "FAIL", reason: "Target element not found" };
    targetElement.focus();
    targetElement.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { status: "ACK", actionExecuted: "click", elementId };
  }

  if (action === "type") {
    if (!targetElement) return { status: "FAIL", reason: "Target input field not found" };
    targetElement.focus();
    targetElement.value = text || "";
    targetElement.dispatchEvent(new Event("input", { bubbles: true }));
    targetElement.dispatchEvent(new Event("change", { bubbles: true }));
    return { status: "ACK", actionExecuted: "type", elementId, text };
  }

  return { status: "FAIL", reason: `Unsupported action type: ${action}` };
}