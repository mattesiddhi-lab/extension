chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "REDACT_IMAGE") {
    handlePipeline(request.imageUri)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

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