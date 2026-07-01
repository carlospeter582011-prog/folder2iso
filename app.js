const tray = document.getElementById('tray');
const dirInput = document.getElementById('dirInput');
const pickBtn = document.getElementById('pickBtn');
const manifestEl = document.getElementById('manifest');
const folderNameEl = document.getElementById('folderName');
const statFiles = document.getElementById('statFiles');
const statDirs = document.getElementById('statDirs');
const statSize = document.getElementById('statSize');
const volumeLabelInput = document.getElementById('volumeLabel');
const buildBtn = document.getElementById('buildBtn');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressPct = document.getElementById('progressPct');
const progressPhase = document.getElementById('progressPhase');
const doneWrap = document.getElementById('doneWrap');
const doneText = document.getElementById('doneText');
const errorBox = document.getElementById('errorBox');
const activityLight = document.getElementById('activityLight');
const offlineBadge = document.getElementById('offlineBadge');

let currentTree = null;
let currentStats = null;
let currentName = 'DISC';

function bytesToSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}
function clearError() {
  errorBox.classList.remove('show');
}

async function handleTree(tree, name) {
  clearError();
  currentTree = tree;
  currentName = name;
  currentStats = window.IsoBuilder.countStats(tree);

  folderNameEl.textContent = name;
  statFiles.textContent = currentStats.files.toLocaleString();
  statDirs.textContent = currentStats.dirs.toLocaleString();
  statSize.textContent = bytesToSize(currentStats.bytes);
  volumeLabelInput.value = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32) || 'DISC';

  manifestEl.classList.add('show');
  doneWrap.classList.remove('show');
  progressWrap.classList.remove('show');

  if (currentStats.files === 0) {
    showError('This folder has no files in it — nothing to put on the disc.');
    buildBtn.disabled = true;
  } else {
    buildBtn.disabled = false;
  }
}

// ---------- Folder picking: prefer File System Access API, fall back to webkitdirectory ----------
async function pickFolder() {
  clearError();
  if ('showDirectoryPicker' in window) {
    try {
      const handle = await window.showDirectoryPicker();
      const tree = await window.IsoBuilder.buildTreeFromDirHandle(handle, handle.name);
      await handleTree(tree, handle.name);
    } catch (err) {
      if (err.name !== 'AbortError') showError('Could not read that folder: ' + err.message);
    }
  } else {
    dirInput.click();
  }
}

dirInput.addEventListener('change', async () => {
  const files = Array.from(dirInput.files || []);
  if (!files.length) return;
  const topName = (files[0].webkitRelativePath || files[0].name).split('/')[0];
  const tree = window.IsoBuilder.buildTreeFromFileList(files, topName);
  await handleTree(tree, topName);
});

pickBtn.addEventListener('click', pickFolder);
tray.addEventListener('click', (e) => { if (e.target === tray || e.target.closest('.tray') === tray && e.target.tagName !== 'BUTTON') pickFolder(); });
tray.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFolder(); } });

['dragenter','dragover'].forEach(evt => tray.addEventListener(evt, (e) => {
  e.preventDefault(); tray.classList.add('drag');
}));
['dragleave','drop'].forEach(evt => tray.addEventListener(evt, (e) => {
  e.preventDefault(); tray.classList.remove('drag');
}));

tray.addEventListener('drop', async (e) => {
  clearError();
  const items = e.dataTransfer.items;
  if (!items || !items.length) return;

  // Try FileSystemDirectoryEntry (webkit drag-drop API) for full folder trees.
  const entry = items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;
  if (entry && entry.isDirectory) {
    const tree = await treeFromEntry(entry);
    await handleTree(tree, entry.name);
  } else if (entry && entry.isFile) {
    showError('Please drop a folder, not a single file.');
  } else {
    showError('Your browser could not read the dropped folder. Try the "Choose folder" button instead.');
  }
});

function treeFromEntry(entry) {
  return new Promise((resolve, reject) => {
    const root = new (window.IsoBuilder.TreeNodeCtor || Object)();
    // We don't have direct TreeNode export, so rebuild using the FileList-compatible path.
    const files = [];
    function walk(dirEntry, path) {
      return new Promise((res, rej) => {
        const reader = dirEntry.createReader();
        const entries = [];
        function readBatch() {
          reader.readEntries((batch) => {
            if (!batch.length) {
              Promise.all(entries.map(en => en.isDirectory
                ? walk(en, path + '/' + en.name)
                : new Promise((rf) => en.file((f) => {
                    Object.defineProperty(f, 'webkitRelativePath', { value: path + '/' + en.name, writable: true });
                    files.push(f);
                    rf();
                  }))
              )).then(res).catch(rej);
            } else {
              entries.push(...batch);
              readBatch();
            }
          }, rej);
        }
        readBatch();
      });
    }
    walk(entry, entry.name).then(() => {
      resolve(window.IsoBuilder.buildTreeFromFileList(files, entry.name));
    }).catch(reject);
  });
}

// ---------- Build & download ----------
buildBtn.addEventListener('click', async () => {
  if (!currentTree) return;
  clearError();
  buildBtn.disabled = true;
  pickBtn.disabled = true;
  progressWrap.classList.add('show');
  doneWrap.classList.remove('show');
  activityLight.classList.add('on');

  const label = (volumeLabelInput.value || 'DISC').toUpperCase().slice(0, 32);
  const suggestedName = `${currentName.replace(/[^A-Za-z0-9_\-]/g, '_')}.iso`;

  try {
    let writable, finish;
    if ('showSaveFilePicker' in window) {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'ISO disk image', accept: { 'application/x-iso9660-image': ['.iso'] } }],
      });
      const fileWritable = await handle.createWritable();
      writable = { write: (chunk) => fileWritable.write(chunk) };
      finish = () => fileWritable.close();
    } else {
      // Fallback: buffer in memory then trigger a normal download.
      const chunks = [];
      writable = { write: (chunk) => { chunks.push(chunk); } };
      finish = () => {
        const blob = new Blob(chunks, { type: 'application/x-iso9660-image' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = suggestedName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
    }

    await window.IsoBuilder.writeIso(currentTree, label, writable, ({ written, total, phase }) => {
      const pct = total > 0 ? Math.min(100, (written / total) * 100) : 0;
      progressFill.style.width = pct.toFixed(1) + '%';
      progressPct.textContent = pct.toFixed(0) + '%';
      progressPhase.textContent = phase === 'done' ? 'Finalizing image…' : `Writing: ${phase.replace(/^(dir|file):/, '')}`;
    });

    await finish();

    progressPhase.textContent = 'Complete.';
    doneWrap.classList.add('show');
    doneText.innerHTML = `<strong>${suggestedName} written</strong>${bytesToSize(currentStats.bytes)} across ${currentStats.files.toLocaleString()} files — saved locally, nothing left your device.`;
  } catch (err) {
    if (err.name === 'AbortError') {
      progressWrap.classList.remove('show');
    } else {
      showError('Build failed: ' + err.message);
      console.error(err);
    }
  } finally {
    buildBtn.disabled = false;
    pickBtn.disabled = false;
    activityLight.classList.remove('on');
  }
});

// ---------- Service worker registration (offline-capable PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      offlineBadge.textContent = 'Offline-ready';
      offlineBadge.classList.add('ready');
    } catch (e) {
      offlineBadge.textContent = 'Offline mode unavailable';
    }
  });
} else {
  offlineBadge.textContent = 'Runs locally in-browser';
}

if (!('showDirectoryPicker' in window)) {
  dirInput.setAttribute('webkitdirectory', '');
  dirInput.setAttribute('directory', '');
}
