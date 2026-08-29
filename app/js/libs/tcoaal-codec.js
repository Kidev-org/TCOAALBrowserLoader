/*
 * TCOAAL Browser Player
 * Copyright (C) 2026 kidev
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
"use strict";

/*
 * The game's asset codec, shared by the service worker and the mod tools.
 * Mirrors server.js hashPath/fileMask/dekit byte for byte; enkit is the
 * inverse of dekit and is used when writing a mod's files back into a tree
 * the game will read.
 */
(function (root) {
  var ASSET_SIG = [84, 67, 79, 65, 65, 76]; // "TCOAAL"

  async function hashPath(logicalPath) {
    var parts = logicalPath.split(/[/\\]/);
    var fname = parts[parts.length - 1];
    var data = new TextEncoder().encode(parts.join("/"));
    var buf = await crypto.subtle.digest("SHA-256", data);
    var hex = Array.prototype.map
      .call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("")
      .slice(0, 16);
    if (fname.toUpperCase().indexOf("[BUST]") !== -1) hex += "[BUST]";
    if (fname.charAt(0) === "!") hex = "!" + hex;
    parts[parts.length - 1] = hex;
    return parts.join("/");
  }

  function fileMask(hashedRelPath) {
    var fname = decodeURIComponent(hashedRelPath).split("/").pop().toUpperCase();
    var m = 0;
    for (var i = 0; i < fname.length; i++) m = (m << 1) ^ fname.charCodeAt(i);
    return m;
  }

  function isEncrypted(bytes) {
    if (bytes.length < ASSET_SIG.length + 1) return false;
    for (var i = 0; i < ASSET_SIG.length; i++) {
      if (bytes[i] !== ASSET_SIG[i]) return false;
    }
    return true;
  }

  function readKeyByte(bytes) {
    return isEncrypted(bytes) ? bytes[ASSET_SIG.length] : -1;
  }

  function dekit(bytes, hashedRelPath) {
    if (!isEncrypted(bytes)) return bytes;
    var keyByte = bytes[ASSET_SIG.length];
    var payload = bytes.subarray(ASSET_SIG.length + 1);
    var mask = (fileMask(hashedRelPath) + 1) & 0xff;
    if (keyByte === 0) keyByte = payload.length;
    var out = new Uint8Array(payload.length);
    for (var i = 0; i < payload.length; i++) {
      if (i < keyByte) {
        var b = payload[i];
        out[i] = b ^ mask;
        mask = ((mask << 1) ^ b) & 0xff;
      } else {
        out[i] = payload[i];
      }
    }
    return out;
  }

  // Inverse of dekit. The mask chains on the CIPHERTEXT byte, which is what
  // dekit reads back, so the two only agree if enkit chains on its own output.
  function enkit(bytes, hashedRelPath, keyByte) {
    var n = keyByte === 0 ? bytes.length : Math.min(keyByte, bytes.length);
    var mask = (fileMask(hashedRelPath) + 1) & 0xff;
    var out = new Uint8Array(ASSET_SIG.length + 1 + bytes.length);
    out.set(ASSET_SIG, 0);
    out[ASSET_SIG.length] = keyByte & 0xff;
    var body = out.subarray(ASSET_SIG.length + 1);
    body.set(bytes);
    for (var i = 0; i < n; i++) {
      var c = bytes[i] ^ mask;
      body[i] = c;
      mask = ((mask << 1) ^ c) & 0xff;
    }
    return out;
  }

  /*
   * Where the shipped game keeps the file a piece of game data calls
   * `logicalRel`, and whether it stores it inside a TCOAAL container.
   *
   * The game's own data never names a file the way the disk does: a map that
   * shows "cameraview" ends up reading img/pictures/<16 hex>. App.redirect()
   * in the game's DRM payload is what bridges the two, and it only bridges
   * three families:
   *
   *   img/**       ImageManager.loadBitmap  -> App.redirect
   *   audio/**     AudioManager.createBuffer -> App.redirect
   *   data/*.json  DataManager.loadDatabase / loadMapData -> App.redirect
   *
   * Everything else is opened under its own name and read raw, so hashing it
   * would bury it where nothing looks: js/, fonts/, icon/, greenworks/,
   * index.html, the notices, the non-JSON files in data/ (Credits.txt and the
   * language blob, which ships unencrypted), languages/** (Crypto.dekit
   * exempts by name), and movies/**, which the stock engine hands straight to
   * a <video src> with neither a redirect nor a decrypt.
   *
   * A name that is ALREADY a storage name is returned as it stands, minus any
   * extension a project tool appended to it. Hashing a hash is the one way
   * this mapping can quietly lose a file.
   */
  var STORAGE_NAME = /^!?[0-9a-f]{16}(\[BUST\])?$/;
  var REDIRECTED = /^(img|audio)\/|^data\/[^/]+\.json$/i;

  async function storagePath(logicalRel) {
    if (!REDIRECTED.test(logicalRel)) return { rel: logicalRel, enc: false };
    var slash = logicalRel.lastIndexOf("/");
    var name = logicalRel.slice(slash + 1);
    var dot = name.lastIndexOf(".");
    var stem = dot > 0 ? name.slice(0, dot) : name;
    if (STORAGE_NAME.test(stem)) {
      return { rel: logicalRel.slice(0, slash + 1) + stem, enc: true };
    }
    return { rel: await hashPath(logicalRel), enc: true };
  }

  root.TcoaalCodec = {
    ASSET_SIG: ASSET_SIG,
    hashPath: hashPath,
    storagePath: storagePath,
    fileMask: fileMask,
    isEncrypted: isEncrypted,
    readKeyByte: readKeyByte,
    dekit: dekit,
    enkit: enkit,
  };
})(typeof self !== "undefined" ? self : this);
