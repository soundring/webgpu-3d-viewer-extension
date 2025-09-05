// Listener for the popup buttons to open viewer or visualization pages
document.addEventListener('DOMContentLoaded', () => {
  const viewerBtn = document.getElementById('openViewer');
  if (viewerBtn) {
    viewerBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
    });
  }
  const vizBtn = document.getElementById('openViz');
  if (vizBtn) {
    vizBtn.addEventListener('click', () => {
   chrome.tabs.create({ url: chrome.runtime.getURL('visualiz' + 'ation.html') });
    });
  }
});
