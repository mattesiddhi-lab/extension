let socket = null;
const SERVER_WS_URL = "ws://127.0.0.1:8000/ws/agent";

// --- Initialize WebSocket Connection ---
function initWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(SERVER_WS_URL);

  socket.onopen = () => {
    console.log("[Background WS] Connected to CV Server Endpoint.");
  };

  socket.onmessage = async (event) => {
    try {
      const serverPayload = JSON.parse(event.data);
      console.log("[Background WS] Received payload from server:", serverPayload);

      if (serverPayload.type === "EXECUTE_ACTION" && serverPayload.jsonAction) {
        await dispatchActionToActiveTab(serverPayload.jsonAction, serverPayload.stepId);
      }
    } catch (err) {
      console.error("[Background WS] Failed to parse incoming message:", err);
    }
  };

  socket.onerror = (err) => {
    console.error("[Background WS] WebSocket Error:", err);
  };

  socket.onclose = () => {
    setTimeout(initWebSocket, 3000);
  };
}

initWebSocket();

// --- Main Message Listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ imageUri: null, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ imageUri: dataUrl });
      }
    });
    return true; // Keep message channel open for async response
  }
});
// Listen for the completed pipeline payload from content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "PIPELINE_COMPLETE") {
    console.log("Sending redacted payload to VLM backend...");

    // Send payload to your team's central server
    fetch("http://localhost:8000/process-screen", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message.payload)
    })
      .then((res) => res.json())
      .then((data) => {
        console.log("Response from VLM server:", data);
        // Send the action back to content script to execute on page
        if (sender.tab && sender.tab.id && data.action) {
          chrome.tabs.sendMessage(sender.tab.id, {
            action: "EXECUTE_JSON_ACTION",
            jsonAction: data.action
          });
        }
      })
      .catch((err) => console.error("Failed to reach VLM backend:", err));
  }
});
// --- Robust Step Orchestration ---
async function runOrchestrationStep(userRequest) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active browser tab found.");

  if (
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("https://chrome.google.com")
  ) {
    throw new Error("Cannot execute on restricted internal Chrome pages.");
  }

  // Ensure content script is actively injected before sending messages
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (e) {
    // Content script already loaded or active
  }

  // 1. Capture Visible Tab
  const imageUri = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  // 2. Delegate DOM Extraction & Redaction to Content Script
  const contentResult = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      { action: "EXECUTE_PIPELINE", imageUri, userRequest },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response || !response.success) {
          return reject(new Error(response ? response.error : "Content pipeline failed"));
        }
        resolve(response.result);
      }
    );
  });

  // 3. Send Payload to Backend Server
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "SCREEN_ANALYSIS_REQUEST",
        payload: contentResult
      })
    );
    return { status: "Sent via WebSocket", payload: contentResult };
  } else {
    console.warn("[Background] WS unavailable. Posting via HTTP...");
    const httpRes = await uploadPayloadHttp(contentResult);
    return { status: "Sent via HTTP Fallback", serverResponse: httpRes, payload: contentResult };
  }
}

async function uploadPayloadHttp(payload) {
  const response = await fetch("http://127.0.0.1:8000/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
  return await response.json();
}

async function dispatchActionToActiveTab(jsonAction, stepId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.tabs.sendMessage(tab.id, { action: "EXECUTE_JSON_ACTION", jsonAction }, (response) => {
    const executionResult = response || { status: "FAIL", reason: "No response from page" };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "ACTION_EXECUTION_RESULT",
          stepId: stepId,
          result: executionResult
        })
      );
    }
  });
}