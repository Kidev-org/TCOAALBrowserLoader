// Injected by MainActivity after every page load. Bridges the player's saves to
// a tiny native file (SaveStore) that rides Android Auto Backup, so saves survive
// a factory reset / new device even though the game-file IndexedDB does not.
//
// Mirrors the exact save schema the web app uses:
//   - localStorage keys matching SAVE_KEY_RE are the live saves.
//   - IndexedDB "tcoaal-saves" / store "saves" (out-of-line keys) is the durable
//     copy the app itself restores from on boot.
(function () {
  if (window.__nativeSaveSync) return;
  var BRIDGE = window.AndroidSaveBridge;
  if (!BRIDGE) return;

  // RPG File1 / RPG File1bak / RPG Global / RPG Config, optionally mod/lang scoped
  // (e.g. "translation_fr:RPG File1").
  var SAVE_KEY_RE = /^(?:[^:]+:)?RPG (?:File\d+(?:bak)?|Global|Config)$/;
  var SAVE_DB = "tcoaal-saves";
  var SAVE_STORE = "saves";
  var SAVE_DB_VERSION = 1;

  function collect() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && SAVE_KEY_RE.test(k)) out[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return out;
  }

  function openDb(cb) {
    try {
      var req = indexedDB.open(SAVE_DB, SAVE_DB_VERSION);
      req.onupgradeneeded = function (e) {
        try {
          e.target.result.createObjectStore(SAVE_STORE);
        } catch (_) {}
      };
      req.onsuccess = function () {
        cb(req.result);
      };
      req.onerror = function () {
        cb(null);
      };
    } catch (e) {
      cb(null);
    }
  }

  var api = {
    // Push current saves out to native. Called on a timer, on hide, and on pause.
    export: function () {
      try {
        var data = collect();
        if (Object.keys(data).length) {
          BRIDGE.onSavesExported(JSON.stringify(data));
        }
      } catch (e) {}
    },

    // Called by native (via evaluateJavascript) with the backed-up snapshot.
    // Non-destructive: only restores keys that are ABSENT locally, so a newer
    // local save is never clobbered by an older cloud copy.
    import: function (json) {
      var data;
      try {
        data = JSON.parse(json);
      } catch (e) {
        return;
      }
      var restored = {};
      Object.keys(data).forEach(function (k) {
        try {
          if (localStorage.getItem(k) === null) {
            localStorage.setItem(k, data[k]);
            restored[k] = data[k];
          }
        } catch (e) {}
      });
      var keys = Object.keys(restored);
      if (!keys.length) return;
      // Also seed the IndexedDB mirror so the app's own boot-time restore agrees.
      openDb(function (db) {
        if (!db) return;
        try {
          var tx = db.transaction(SAVE_STORE, "readwrite");
          var os = tx.objectStore(SAVE_STORE);
          keys.forEach(function (k) {
            try {
              os.put(restored[k], k);
            } catch (e) {}
          });
        } catch (e) {}
      });
    },
  };
  window.__nativeSaveSync = api;

  // On startup, ask native to restore any cloud-backed saves onto this device.
  try {
    BRIDGE.onRestoreRequested();
  } catch (e) {}

  // Mirror saves out shortly after load and whenever the page is backgrounded.
  setTimeout(api.export, 4000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") api.export();
  });
})();
