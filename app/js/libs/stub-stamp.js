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
 * Turns a CI-built per-platform installer stub into a mod-carrying binary,
 * used by app/create.html. Three platforms, three attachment strategies:
 *
 *   - Windows: PeResources.stamp() rewrites the stub's .rsrc section (icon +
 *     product name), THEN the .tcoaalmod payload is appended as a trailer.
 *   - Linux: the stub is an AppImage; appending past its squashfs still
 *     runs, so the payload is just a trailer, same layout as Windows.
 *   - macOS: the stub is a .app bundle delivered as a zip. Appending bytes
 *     to a Mach-O invalidates its code signature (and the Apple Silicon
 *     kernel refuses to exec an invalidly-signed binary), so the payload
 *     instead becomes a new zip entry under Contents/Resources/, and the
 *     icon + Info.plist entries are rewritten in place. Everything under
 *     Contents/MacOS/ (the signed binary itself) passes through untouched.
 *
 * Trailer layout (Windows and Linux): [stub][payload][u64 LE length][magic].
 * The u64 is written as two u32 halves, low word first then high word,
 * which is bit-for-bit identical to a native little-endian 64-bit write; it
 * just avoids needing BigInt for a value that always fits well within the
 * 53 safe integer bits JS numbers give us.
 */
(function (root) {
  var MAGIC = "TCOAALPK";
  var MAGIC_BYTES = new TextEncoder().encode(MAGIC);

  function concat(parts) {
    var n = 0,
      i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    var o = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], o);
      o += parts[i].length;
    }
    return out;
  }

  function attachTrailer(stub, payload) {
    var length = payload.length;
    var lenBytes = new Uint8Array(8);
    var ldv = new DataView(lenBytes.buffer);
    ldv.setUint32(0, length >>> 0, true); // low 32 bits
    ldv.setUint32(4, Math.floor(length / 4294967296) >>> 0, true); // high 32 bits
    return concat([stub, payload, lenBytes, MAGIC_BYTES]);
  }

  // Returns null, and never throws, both for the ordinary "no trailer here"
  // case (an un-stamped stub) and for a hostile/corrupt tail: a magic that
  // happens to match without a sane length behind it, or a length field
  // claiming more bytes than the buffer holds. The only slice this function
  // ever returns is bytes.slice(start, bytes.length - 16) with start already
  // verified >= 0, so it can never read out of bounds or before offset 0.
  function readTrailer(bytes) {
    if (!bytes || bytes.length < 16) return null;
    var tailOff = bytes.length - 8;
    for (var i = 0; i < 8; i++) {
      if (bytes[tailOff + i] !== MAGIC_BYTES[i]) return null;
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var lenOff = bytes.length - 16;
    var lo = dv.getUint32(lenOff, true);
    var hi = dv.getUint32(lenOff + 4, true);
    var length = hi * 4294967296 + lo;
    if (!Number.isSafeInteger(length)) return null;
    var start = bytes.length - 16 - length;
    if (start < 0) return null;
    return bytes.slice(start, start + length);
  }

  async function sha256Hex(bytes) {
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    var view = new Uint8Array(digest);
    var hex = "";
    for (var i = 0; i < view.length; i++) {
      hex += (view[i] < 16 ? "0" : "") + view[i].toString(16);
    }
    return hex;
  }

  // Compares the FULL 64-character digest, never a prefix, and throws
  // (rather than resolving) on any mismatch. The error names artifactName
  // so a modder who downloaded several stubs knows which one is bad.
  async function verifyStub(bytes, expectedSha256Hex, artifactName) {
    var actual = await sha256Hex(bytes);
    var expected = String(expectedSha256Hex).toLowerCase();
    if (actual !== expected) {
      throw new Error(
        'Checksum mismatch for "' +
          artifactName +
          '": expected ' +
          expected +
          ", got " +
          actual +
          ". The download may be corrupt or tampered with; try downloading it again.",
      );
    }
  }

  // stampWindows always stamps the resources FIRST and attaches the trailer
  // SECOND, in that order, inside this one function. PeResources.stamp()
  // rebuilds the file up to the end of the last section it owns (the rebuilt
  // .rsrc, wherever it lands), so a trailer attached before stamping would
  // simply be discarded. There is no way to call this API in the wrong order
  // because the two steps are not separately exposed.
  function stampWindows(stub, opts) {
    var payload = opts.payload,
      icons = opts.icons || [],
      name = opts.name;
    var info = root.PeResources.parse(stub);
    var last = info.sections[info.sections.length - 1];
    // When .rsrc is already last, PeResources.stamp() rebuilds it at its own
    // RVA, and its SizeOfImage computation (last.virtualAddress +
    // ceil(sectionLength / sectionAlignment) * sectionAlignment) is only
    // correct if that VirtualAddress is already a multiple of
    // SectionAlignment, true for any normal linker's output, but never
    // confirmed here against a real CI-built stub. Refuse loudly instead of
    // silently emitting an exe with a SizeOfImage that itself violates the
    // same alignment rule, which the OS loader would reject. (When .rsrc is
    // not last, the MSVC shape with .reloc behind it, stamp() appends a new
    // section at an RVA it aligns itself, so there is nothing to check.)
    if (last.name === ".rsrc" && last.virtualAddress % info.sectionAlignment !== 0) {
      throw new Error(
        'Stub\'s last section ("' +
          last.name +
          '") VirtualAddress 0x' +
          last.virtualAddress.toString(16) +
          " is not a multiple of SectionAlignment 0x" +
          info.sectionAlignment.toString(16) +
          "; refusing to stamp. This stub was not produced by a normal linker.",
      );
    }
    var stamped = root.PeResources.stamp(stub, icons, name);
    return attachTrailer(stamped, payload);
  }

  function stampLinux(appimage, opts) {
    return attachTrailer(appimage, opts.payload);
  }

  function setPlistString(text, key, value) {
    var re = new RegExp("(<key>" + key + "</key>\\s*<string>)([\\s\\S]*?)(</string>)");
    if (!re.test(text)) throw new Error("Info.plist has no " + key + " entry.");
    return text.replace(
      re,
      "$1" +
        value.replace(/[&<>]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
        }) +
        "$3",
    );
  }

  // Rewrites exactly three things inside the stub zip (the icon, the three
  // identity strings in Info.plist, and a new payload entry) and leaves
  // every other entry byte-identical, in particular everything under
  // Contents/MacOS/ (the signed binary), which is the entire reason macOS
  // uses this path instead of appending a trailer like Windows/Linux do.
  async function stampMac(zipBytes, opts) {
    var payload = opts.payload,
      icnsBytes = opts.icnsBytes,
      name = opts.name,
      bundleId = opts.bundleId;
    var entries = await root.ModPackage.readZip(zipBytes);

    var infoPlistName = null;
    entries.forEach(function (_data, key) {
      if (/\/Contents\/Info\.plist$/.test(key)) infoPlistName = key;
    });
    if (!infoPlistName) throw new Error("Stub zip has no */Contents/Info.plist entry.");
    var appPrefix = infoPlistName.slice(0, infoPlistName.length - "/Contents/Info.plist".length);

    var iconName = appPrefix + "/Contents/Resources/icon.icns";
    if (!entries.has(iconName)) throw new Error("Stub zip has no " + iconName + " entry.");

    var plistText = new TextDecoder().decode(entries.get(infoPlistName));
    plistText = setPlistString(plistText, "CFBundleName", name);
    plistText = setPlistString(plistText, "CFBundleDisplayName", name);
    plistText = setPlistString(plistText, "CFBundleIdentifier", bundleId);

    var payloadName = appPrefix + "/Contents/Resources/payload.tcoaalmod";
    var out = [];
    entries.forEach(function (data, key) {
      if (key === infoPlistName) {
        out.push({ name: key, data: new TextEncoder().encode(plistText) });
      } else if (key === iconName) {
        out.push({ name: key, data: icnsBytes });
      } else {
        // Byte-identical passthrough, notably everything under
        // Contents/MacOS/, which must never be touched.
        out.push({ name: key, data: data });
      }
    });
    out.push({ name: payloadName, data: payload });

    return root.ModPackage.writeZip(out);
  }

  // Browser-only (createImageBitmap / OffscreenCanvas / convertToBlob have
  // no Node equivalent), so this is exercised by the manual check in
  // app/create.html's own task, not by tools/test-create.js.
  async function renderIconSizes(pngBytes, sizes) {
    var bitmap = await createImageBitmap(new Blob([pngBytes], { type: "image/png" }));
    var out = new Map();
    for (var i = 0; i < sizes.length; i++) {
      var size = sizes[i];
      var canvas = new OffscreenCanvas(size, size);
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bitmap, 0, 0, size, size);
      var blob = await canvas.convertToBlob({ type: "image/png" });
      out.set(size, new Uint8Array(await blob.arrayBuffer()));
    }
    return out;
  }

  root.StubStamp = {
    MAGIC: MAGIC,
    attachTrailer: attachTrailer,
    readTrailer: readTrailer,
    verifyStub: verifyStub,
    stampWindows: stampWindows,
    stampLinux: stampLinux,
    stampMac: stampMac,
    renderIconSizes: renderIconSizes,
  };
})(typeof self !== "undefined" ? self : this);
