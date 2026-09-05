document.getElementById("runBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("status");
  statusEl.innerText = "Capturing & Redacting...";

  chrome.runtime.sendMessage({ action: "CAPTURE_AND_REDACT" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.innerText = "Error: " + chrome.runtime.lastError.message;
      return;
    }

    if (response && response.success) {
      statusEl.innerText = "Sanitized! Image ready.";
      console.log("Sanitized image DataURL:", response.sanitizedImage.substring(0, 100) + "...");
    } else {
      statusEl.innerText = "Failed: " + (response ? response.error : "Unknown error");
    }
  });
});