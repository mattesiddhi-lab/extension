chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CAPTURE_AND_REDACT") {
    // 1. Get the current active window & tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.id) {
        sendResponse({ success: false, error: "No active tab found" });
        return;
      }

      try {
        // 2. Capture the visible screen area as JPEG
        const dataUrl = await chrome.tabs.captureVisibleTab(null, {
          format: "jpeg",
          quality: 80
        });

        // 3. Send raw image data to content.js on the active tab for redaction
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          action: "REDACT_IMAGE",
          imageUri: dataUrl
        });

        sendResponse(response);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });

    return true; // Keep message channel open for async response
  }
});