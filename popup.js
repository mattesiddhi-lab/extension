document.getElementById("runBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("status");
  const statsBox = document.getElementById("stats");
  const previewBox = document.getElementById("previewContainer");
  const previewImg = document.getElementById("sanitizedPreview");

  statusEl.innerText = "Processing & Redacting...";

  chrome.runtime.sendMessage({ action: "CAPTURE_AND_REDACT" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.innerText = "Error: " + chrome.runtime.lastError.message;
      return;
    }

    if (response && response.success) {
      statusEl.innerText = "Complete!";
      
      // Update Telemetry & Details
      statsBox.style.display = "block";
      document.getElementById("statRedacted").innerText = response.result.visualFeatures.redactedElements;
      document.getElementById("statCandidates").innerText = response.result.visualFeatures.interactiveCandidates.length;
      document.getElementById("statAction").innerText = response.result.action || "None";

      // Render the redacted screenshot sent over the wire
      previewBox.style.display = "block";
      previewImg.src = response.result.sanitizedImage;
    } else {
      statusEl.innerText = "Failed: " + (response ? response.error : "Unknown error");
    }
  });
});
