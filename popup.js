// Listener for the popup button to open the viewer page in a new tab.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('openViewer');
  if (btn) {
    btn.addEventListener('click', () => {
      // Open viewer.html in a new tab
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
    });
  }
});