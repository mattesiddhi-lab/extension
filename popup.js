document.getElementById("runBtn").addEventListener("click", () => {
  const statusEl = document.getElementById("status");
  const statsBox = document.getElementById("stats");
  const previewBox = document.getElementById("previewContainer");
  const previewImg = document.getElementById("sanitizedPreview");

  statusEl.innerText = "Capturing & Redacting...";

  chrome.runtime.sendMessage({ action: "CAPTURE_AND_REDACT" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.innerText = "Error: " + chrome.runtime.lastError.message;
      return;
    }

    if (response && response.success && response.result) {
      statusEl.innerText = "Complete!";

      const vf = response.result.visualFeatures || {};
      document.getElementById("statRedacted").innerText = vf.redactedElements || 0;
      document.getElementById("statCandidates").innerText = (vf.interactiveCandidates || []).length;
      document.getElementById("statAction").innerText = response.result.action || "None";
      statsBox.style.display = "block";

      if (response.result.sanitizedImage) {
        previewImg.src = response.result.sanitizedImage;
        previewBox.style.display = "block";
      }
    } else {
      statusEl.innerText = "Failed: " + (response ? response.error : "Unknown error");
    }
  });
});