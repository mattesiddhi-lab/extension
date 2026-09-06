document.addEventListener("DOMContentLoaded", () => {
  const captureBtn = document.getElementById("captureBtn");
  const statusDiv = document.getElementById("status");

  if (!captureBtn) {
    console.error("[Popup Error] Could not find element with id='captureBtn'");
    return;
  }

  // Bind click listener directly
  captureBtn.onclick = async () => {
    try {
      if (statusDiv) statusDiv.innerText = "Capturing tab...";

      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        if (statusDiv) statusDiv.innerText = "Error: No active tab found.";
        return;
      }

      // Step 1: Capture visible tab from background script
      chrome.runtime.sendMessage({ action: "CAPTURE_TAB" }, (response) => {
        if (chrome.runtime.lastError || !response || !response.imageUri) {
          const err = chrome.runtime.lastError?.message || response?.error || "Failed tab capture";
          if (statusDiv) statusDiv.innerText = `Error: ${err}`;
          return;
        }

        if (statusDiv) statusDiv.innerText = "Processing screen...";

        // Step 2: Send screenshot data to content script
        chrome.tabs.sendMessage(
          tab.id,
          {
            action: "EXECUTE_PIPELINE",
            imageUri: response.imageUri,
            userRequest: "Redact PII and analyze screen"
          },
          (ackResponse) => {
            if (chrome.runtime.lastError) {
              console.warn("[Popup Message Warning]:", chrome.runtime.lastError.message);
              if (statusDiv) statusDiv.innerText = "Error sending message to page. Try refreshing the web tab.";
            } else if (ackResponse && ackResponse.status === "ACK") {
              if (statusDiv) statusDiv.innerText = "Pipeline running on page...";
            }
          }
        );
      });
    } catch (err) {
      console.error("[Popup Execution Error]:", err);
      if (statusDiv) statusDiv.innerText = `Error: ${err.message}`;
    }
  };

  // Listen for decoupled completion from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "PIPELINE_COMPLETE") {
      console.log("Completed Pipeline Payload:", message.payload);
      if (statusDiv) statusDiv.innerText = "Analysis Complete!";
    }

    if (message.action === "PIPELINE_ERROR") {
      if (statusDiv) statusDiv.innerText = `Error: ${message.error}`;
    }
  });
});