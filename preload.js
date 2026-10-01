const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

function getGifDuration(filePath) {
  const buf = fs.readFileSync(filePath);
  let delay = 0;
  for (let i = 0; i < buf.length - 5; i++) {
    if (buf[i] === 0x21 && buf[i+1] === 0xF9 && buf[i+2] === 0x04) {
      delay += buf[i+4] | (buf[i+5] << 8);
    }
  }
  return Math.max(delay * 10, 1000);
}

contextBridge.exposeInMainWorld('electronAPI', {
  getGifs: () => {
    try {
      const gifDir = path.join(__dirname, 'assets', 'gif');
      return fs.readdirSync(gifDir)
        .filter(f => f.endsWith('.gif'))
        .map(f => ({
          name: f,
          duration: getGifDuration(path.join(gifDir, f))
        }));
    } catch {
      return [];
    }
  },
  onClaudeEvent: (callback) => ipcRenderer.on('claude-event', (_event, ev) => callback(ev)),
  reportStatus: (status) => ipcRenderer.send('pet-status', status),
});
