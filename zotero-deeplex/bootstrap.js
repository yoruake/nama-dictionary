/* Zotero 7 bootstrap entry points. The actual logic lives in deeplex.js. */

var Nama;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;

  // Load the main module into this global scope (defines `Nama`).
  Services.scriptloader.loadSubScript(rootURI + "deeplex.js");

  Nama.init({ id, version, rootURI });
  Nama.registerReaderListener();
  Nama.addToAllWindows();
}

function shutdown() {
  if (!Nama) {
    return;
  }
  Nama.unregisterReaderListener();
  Nama.removeFromAllWindows();
  Nama = undefined;
}

function onMainWindowLoad({ window }) {
  if (Nama) {
    Nama.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (Nama) {
    Nama.removeFromWindow(window);
  }
}
