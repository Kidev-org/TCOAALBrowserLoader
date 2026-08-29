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
 * Minimal PE resource rewriter: replaces the .rsrc section of a stub built by
 * our own CI with a freshly built one carrying the mod's icon and name. This
 * is what rcedit does natively; we need it in the browser because create.html
 * stamps the stub client-side.
 *
 * The rebuild is not a wipe: only the types it actually writes (RT_ICON,
 * RT_GROUP_ICON, RT_VERSION) come from the caller, and every other leaf of the
 * stub's own tree is copied through byte for byte. RT_MANIFEST is why: on
 * Windows the application manifest is what gives a process per-monitor DPI
 * awareness, long path support (an installer walks deep game folders) and
 * common controls v6, none of which announce their absence.
 *
 * Two shapes, because the linker decides where .rsrc lands:
 *
 *   - .rsrc is the LAST section (some linkers, and any exe already stamped by
 *     this file): the section is rebuilt at its own RVA and the file is
 *     truncated behind it, so a stamped exe never grows an extra section per
 *     stamp.
 *   - .rsrc is NOT last (MSVC always emits .reloc after it, which is what our
 *     Windows stub looks like): the rebuilt section is APPENDED as a new
 *     section past every existing one, and the resource data directory is
 *     pointed at it. The old .rsrc stays in the file, mapped but orphaned -
 *     nothing reaches it once data directory 2 no longer names it.
 *
 * Appending needs one free 40-byte slot in the section table, i.e. the header
 * region must have room before the first section's raw data. Every normal
 * linker leaves hundreds of bytes of padding there; stamp() refuses loudly if
 * this one does not.
 */
(function (root) {
  var RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16, LANG = 0x0409;

  function Writer() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
  }
  Writer.prototype._need = function (n) {
    if (this.len + n <= this.buf.length) return;
    var cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  Writer.prototype.u8 = function (v) {
    this._need(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  };
  Writer.prototype.u16 = function (v) {
    return this.u8(v).u8(v >>> 8);
  };
  Writer.prototype.u32 = function (v) {
    return this.u16(v).u16(v >>> 16);
  };
  Writer.prototype.utf16 = function (s) {
    for (var i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this.u16(0);
  };
  Writer.prototype.align = function (n) {
    while (this.len % n !== 0) this.u8(0);
    return this;
  };
  Writer.prototype.patch16 = function (off, v) {
    this.buf[off] = v & 0xff;
    this.buf[off + 1] = (v >>> 8) & 0xff;
    return this;
  };
  Writer.prototype.done = function () {
    return this.buf.subarray(0, this.len).slice();
  };

  function align4(n) {
    return (n + 3) & ~3;
  }

  // parse

  function parse(exe) {
    var dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
    if (exe[0] !== 0x4d || exe[1] !== 0x5a) throw new Error("Not a PE file (no MZ header).");
    var peOffset = dv.getUint32(0x3c, true);
    if (dv.getUint32(peOffset, true) !== 0x00004550) {
      throw new Error("Not a PE file (no PE signature).");
    }
    var numSections = dv.getUint16(peOffset + 6, true);
    var optSize = dv.getUint16(peOffset + 20, true);
    var opt = peOffset + 24;
    var magic = dv.getUint16(opt, true);
    var plus = magic === 0x20b;
    var sectionAlignment = dv.getUint32(opt + 32, true);
    var fileAlignment = dv.getUint32(opt + 36, true);
    var sizeOfImageOffset = opt + 56;
    var sizeOfImage = dv.getUint32(sizeOfImageOffset, true);
    var sizeOfHeaders = dv.getUint32(opt + 60, true);
    // Data directories start after the fixed optional header: 96 bytes for
    // PE32, 112 for PE32+ (ImageBase is 8 bytes in PE32+ and PE32 carries an
    // extra 4-byte BaseOfData field that PE32+ drops, which is why the
    // fields shared by both variants, SectionAlignment, FileAlignment,
    // SizeOfImage and CheckSum, land at the SAME offset in either format).
    // Resources are data directory index 2.
    var ddOffset = opt + (plus ? 112 : 96);
    var resourceDirEntry = ddOffset + 2 * 8;

    var secOff = opt + optSize;
    // A stub with no sections, or one whose table runs past the end of the
    // file, is malformed. Catch it here so callers get this message instead
    // of a DataView RangeError or a TypeError on sections[-1].
    if (numSections < 1) throw new Error("Not a stampable PE file (no sections).");
    if (secOff + numSections * 40 > exe.length) {
      throw new Error("Truncated PE file: the section table runs past the end.");
    }
    var sections = [];
    for (var i = 0; i < numSections; i++) {
      var h = secOff + i * 40;
      var raw = "";
      for (var c = 0; c < 8; c++) {
        var ch = exe[h + c];
        if (!ch) break;
        raw += String.fromCharCode(ch);
      }
      sections.push({
        name: raw,
        virtualSize: dv.getUint32(h + 8, true),
        virtualAddress: dv.getUint32(h + 12, true),
        rawSize: dv.getUint32(h + 16, true),
        rawOffset: dv.getUint32(h + 20, true),
        headerOffset: h,
      });
    }
    return {
      peOffset: peOffset,
      numSections: numSections,
      sections: sections,
      sectionTableOffset: secOff,
      sectionAlignment: sectionAlignment,
      fileAlignment: fileAlignment,
      sizeOfImage: sizeOfImage,
      sizeOfImageOffset: sizeOfImageOffset,
      sizeOfHeaders: sizeOfHeaders,
      resourceDirEntry: resourceDirEntry,
      resourceDirRva: dv.getUint32(resourceDirEntry, true),
      resourceDirSize: dv.getUint32(resourceDirEntry + 4, true),
    };
  }

  // resource payloads

  function buildGroupIcon(icons) {
    var w = new Writer();
    w.u16(0).u16(1).u16(icons.length); // reserved, type=icon, count
    for (var i = 0; i < icons.length; i++) {
      var ic = icons[i];
      w.u8(ic.width >= 256 ? 0 : ic.width);
      w.u8(ic.height >= 256 ? 0 : ic.height);
      w.u8(0).u8(0);      // colorCount, reserved
      w.u16(1).u16(32);   // planes, bitCount
      w.u32(ic.png.length);
      w.u16(i + 1);       // resource id of the RT_ICON entry
    }
    return w.done();
  }

  // One VS_VERSIONINFO block. Every block is [wLength][wValueLength][wType]
  // [szKey UTF-16][pad to 4][value][children]; wLength is back-patched once
  // the block (including its children) is fully assembled.
  function buildVersionInfo(name) {
    var w = new Writer();

    function beginBlock(key, valueLength, type) {
      var at = w.len;
      w.u16(0).u16(valueLength).u16(type);
      w.utf16(key);
      w.align(4);
      return at;
    }
    function endBlock(at) {
      w.patch16(at, w.len - at);
    }

    var vroot = beginBlock("VS_VERSION_INFO", 52, 0);
    w.u32(0xfeef04bd).u32(0x00010000); // signature, strucVersion
    w.u32(0x00010000).u32(0);          // fileVersion  1.0.0.0
    w.u32(0x00010000).u32(0);          // productVersion 1.0.0.0
    w.u32(0x3f).u32(0);                // fileFlagsMask, fileFlags
    w.u32(4).u32(1).u32(0);            // fileOS=VOS__WINDOWS32, fileType=APP, subtype
    w.u32(0).u32(0);                   // fileDate
    w.align(4);

    var sfi = beginBlock("StringFileInfo", 0, 1);
    var table = beginBlock("040904b0", 0, 1);
    ["ProductName", "FileDescription", "InternalName"].forEach(function (key) {
      var s = beginBlock(key, name.length + 1, 1);
      w.utf16(name);
      w.align(4);
      endBlock(s);
    });
    endBlock(table);
    endBlock(sfi);

    var vfi = beginBlock("VarFileInfo", 0, 1);
    var varb = beginBlock("Translation", 4, 0);
    w.u16(0x0409).u16(0x04b0);
    endBlock(varb);
    endBlock(vfi);

    endBlock(vroot);
    return w.done();
  }

  // resource directory

  /**
   * Every leaf of an existing resource tree, so a rebuild can carry over the
   * types it does not itself produce. RT_MANIFEST above all: on Windows the
   * application manifest is what grants per-monitor DPI awareness, long path
   * support (an installer walks deep game folders) and common-controls v6, so
   * dropping it silently degrades every stamped installer. Type/name/language
   * ids come back as numbers, or as strings for the string-named entries some
   * linkers emit; both are written back out in kind.
   *
   * Only the three-level type -> name -> language shape every linker emits is
   * collected; a leaf hanging directly off a type would be malformed, and is
   * skipped rather than guessed at.
   */
  function readResourceTree(exe, info) {
    var out = [];
    if (!info.resourceDirRva) return out;
    var root = rvaToOffset(info, info.resourceDirRva);
    if (root < 0) return out;
    var dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);

    function nameAt(at) {
      var len = dv.getUint16(at, true);
      var s = "";
      for (var i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(at + 2 + i * 2, true));
      return s;
    }
    function walk(at, path) {
      var total = dv.getUint16(at + 12, true) + dv.getUint16(at + 14, true);
      for (var i = 0; i < total; i++) {
        var eo = at + 16 + i * 8;
        var nm = dv.getUint32(eo, true);
        var ptr = dv.getUint32(eo + 4, true);
        var id = nm & 0x80000000 ? nameAt(root + (nm & 0x7fffffff)) : nm;
        if (ptr & 0x80000000) {
          if (path.length < 2) walk(root + (ptr & 0x7fffffff), path.concat([id]));
        } else if (path.length === 2) {
          var de = root + ptr;
          var off = rvaToOffset(info, dv.getUint32(de, true));
          var size = dv.getUint32(de + 4, true);
          if (off >= 0 && off + size <= exe.length) {
            out.push({ type: path[0], name: path[1], lang: id, data: exe.subarray(off, off + size) });
          }
        }
      }
    }
    walk(root, []);
    return out;
  }

  /** Directory entries: named ones first, by string, then ids ascending. */
  function sortEntries(list) {
    function key(id) {
      return typeof id === "string" ? id.toUpperCase() : id;
    }
    var named = [];
    var ided = [];
    for (var i = 0; i < list.length; i++) {
      (typeof list[i].id === "string" ? named : ided).push(list[i]);
    }
    named.sort(function (a, b) {
      return key(a.id) < key(b.id) ? -1 : key(a.id) > key(b.id) ? 1 : 0;
    });
    ided.sort(function (a, b) {
      return a.id - b.id;
    });
    return named.concat(ided);
  }

  function buildResourceSection(icons, versionName, baseRva, carry) {
    // Three levels: type -> name -> language. Payloads follow the tree.
    var types = [];
    var i, j, k;

    function dir(list, id, childKey) {
      for (var n = 0; n < list.length; n++) {
        if (list[n].id === id) return list[n];
      }
      var made = { id: id };
      made[childKey] = [];
      list.push(made);
      return made;
    }
    function put(typeId, nameId, langId, data) {
      var names = dir(types, typeId, "names").names;
      dir(names, nameId, "langs").langs.push({ id: langId, data: data });
    }

    // The types this rebuild produces itself. Everything else the stub
    // carried is copied through untouched, including its icons when the
    // caller supplied none, which is the difference between "no icon was
    // asked for" and "the icon was erased".
    var rebuilt = icons.length ? [RT_ICON, RT_GROUP_ICON, RT_VERSION] : [RT_VERSION];

    for (i = 0; i < icons.length; i++) {
      // Payloads are 4-byte aligned by advancing a cursor, so a zero-length
      // one would not advance it and two icons would share an RVA. Nothing
      // reads across the boundary (the entry's size is 0), but it is a
      // degenerate tree, and an empty icon is a caller bug either way.
      if (!icons[i].png || !icons[i].png.length) {
        throw new Error("Icon " + (i + 1) + " (" + icons[i].width + "px) has no image data.");
      }
      put(RT_ICON, i + 1, LANG, icons[i].png);
    }
    if (icons.length) put(RT_GROUP_ICON, 1, LANG, buildGroupIcon(icons));
    put(RT_VERSION, 1, LANG, buildVersionInfo(versionName));

    for (i = 0; carry && i < carry.length; i++) {
      if (rebuilt.indexOf(carry[i].type) === -1) {
        put(carry[i].type, carry[i].name, carry[i].lang, carry[i].data);
      }
    }

    // Sorting is what satisfies the loader's binary search: at every level,
    // string-named entries first in string order, then numeric ids ascending.
    types = sortEntries(types);
    for (i = 0; i < types.length; i++) {
      types[i].names = sortEntries(types[i].names);
      for (j = 0; j < types[i].names.length; j++) {
        types[i].names[j].langs = sortEntries(types[i].names[j].langs);
      }
    }

    // Layout: root dir, one dir per type, one dir per name, then the data
    // entries, then the name strings, then the payloads.
    var DIR = 16, ENT = 8, DATA = 16;
    var leaves = [];
    var offset = DIR + types.length * ENT;
    for (i = 0; i < types.length; i++) {
      types[i].dirOffset = offset;
      offset += DIR + types[i].names.length * ENT;
    }
    for (i = 0; i < types.length; i++) {
      for (j = 0; j < types[i].names.length; j++) {
        types[i].names[j].dirOffset = offset;
        offset += DIR + types[i].names[j].langs.length * ENT;
      }
    }
    for (i = 0; i < types.length; i++) {
      for (j = 0; j < types[i].names.length; j++) {
        for (k = 0; k < types[i].names[j].langs.length; k++) {
          var leaf = types[i].names[j].langs[k];
          leaf.dataEntryOffset = offset;
          offset += DATA;
          leaves.push(leaf);
        }
      }
    }

    // Name strings, if any: [u16 character count][UTF-16LE], word-aligned,
    // referenced from a directory entry by offset with the high bit set.
    // Prototype-less, because these keys come from the stub's own resource
    // tree: a type named "toString" would otherwise look already-interned and
    // be written out as an offset of Function.prototype.toString.
    var strings = Object.create(null);
    offset = (offset + 1) & ~1;
    function intern(id) {
      if (typeof id !== "string") return -1;
      if (!(id in strings)) {
        strings[id] = offset;
        offset = (offset + 2 + id.length * 2 + 1) & ~1;
      }
      return strings[id];
    }
    for (i = 0; i < types.length; i++) {
      intern(types[i].id);
      for (j = 0; j < types[i].names.length; j++) {
        intern(types[i].names[j].id);
        for (k = 0; k < types[i].names[j].langs.length; k++) {
          intern(types[i].names[j].langs[k].id);
        }
      }
    }

    var cursor = align4(offset);
    for (i = 0; i < leaves.length; i++) {
      leaves[i].payloadOffset = cursor;
      cursor = align4(cursor + leaves[i].data.length);
    }

    var out = new Uint8Array(cursor);
    var dv = new DataView(out.buffer);

    for (var s in strings) {
      if (!Object.prototype.hasOwnProperty.call(strings, s)) continue;
      dv.setUint16(strings[s], s.length, true);
      for (i = 0; i < s.length; i++) dv.setUint16(strings[s] + 2 + i * 2, s.charCodeAt(i), true);
    }

    function writeDir(at, entries) {
      var named = 0;
      for (var e = 0; e < entries.length; e++) {
        if (typeof entries[e].id === "string") named++;
      }
      dv.setUint32(at, 0, true);            // Characteristics
      dv.setUint32(at + 4, 0, true);        // TimeDateStamp
      dv.setUint16(at + 8, 0, true);        // MajorVersion
      dv.setUint16(at + 10, 0, true);       // MinorVersion
      dv.setUint16(at + 12, named, true);   // NumberOfNamedEntries
      dv.setUint16(at + 14, entries.length - named, true); // NumberOfIdEntries
      for (e = 0; e < entries.length; e++) {
        var eo = at + DIR + e * ENT;
        var id = entries[e].id;
        dv.setUint32(eo, typeof id === "string" ? strings[id] | 0x80000000 : id, true);
        dv.setUint32(eo + 4, entries[e].offset | (entries[e].isDir ? 0x80000000 : 0), true);
      }
    }
    function asDirs(list, offsetKey) {
      return list.map(function (e) {
        return { id: e.id, offset: e[offsetKey], isDir: true };
      });
    }

    writeDir(0, asDirs(types, "dirOffset"));
    for (i = 0; i < types.length; i++) {
      writeDir(types[i].dirOffset, asDirs(types[i].names, "dirOffset"));
      for (j = 0; j < types[i].names.length; j++) {
        writeDir(
          types[i].names[j].dirOffset,
          types[i].names[j].langs.map(function (l) {
            return { id: l.id, offset: l.dataEntryOffset, isDir: false };
          })
        );
      }
    }
    for (i = 0; i < leaves.length; i++) {
      var lf = leaves[i];
      dv.setUint32(lf.dataEntryOffset, baseRva + lf.payloadOffset, true); // absolute RVA
      dv.setUint32(lf.dataEntryOffset + 4, lf.data.length, true);
      dv.setUint32(lf.dataEntryOffset + 8, 0, true);  // CodePage
      dv.setUint32(lf.dataEntryOffset + 12, 0, true); // Reserved
      out.set(lf.data, lf.payloadOffset);
    }
    return out;
  }

  // read back (used by tests and by stamp's self-check)

  function rvaToOffset(info, rva) {
    for (var i = 0; i < info.sections.length; i++) {
      var s = info.sections[i];
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        return s.rawOffset + (rva - s.virtualAddress);
      }
    }
    return -1;
  }

  function findResource(exe, info, typeId) {
    var dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
    var rootOff = rvaToOffset(info, info.resourceDirRva);
    if (rootOff < 0) return null;
    function entries(at) {
      var named = dv.getUint16(at + 12, true);
      var ided = dv.getUint16(at + 14, true);
      var out = [];
      for (var i = 0; i < named + ided; i++) {
        var eo = at + 16 + i * 8;
        var off = dv.getUint32(eo + 4, true);
        out.push({
          id: dv.getUint32(eo, true),
          offset: off & 0x7fffffff,
          isDir: !!(off & 0x80000000),
        });
      }
      return out;
    }
    var t = entries(rootOff).filter(function (e) { return e.id === typeId; })[0];
    if (!t) return null;
    var nameEnt = entries(rootOff + t.offset)[0];
    var langEnt = entries(rootOff + nameEnt.offset)[0];
    var de = rootOff + langEnt.offset;
    var dataRva = dv.getUint32(de, true);
    var size = dv.getUint32(de + 4, true);
    var off = rvaToOffset(info, dataRva);
    return off < 0 ? null : exe.subarray(off, off + size);
  }

  function readIconGroup(exe) {
    var info = parse(exe);
    var grp = findResource(exe, info, RT_GROUP_ICON);
    if (!grp) return [];
    var dv = new DataView(grp.buffer, grp.byteOffset, grp.byteLength);
    var count = dv.getUint16(4, true);
    var out = [];
    for (var i = 0; i < count; i++) {
      var e = 6 + i * 14;
      out.push({
        width: grp[e] === 0 ? 256 : grp[e],
        height: grp[e + 1] === 0 ? 256 : grp[e + 1],
        bytes: dv.getUint32(e + 8, true),
        id: dv.getUint16(e + 12, true),
      });
    }
    return out;
  }

  // stamp

  var SCN_CNT_INITIALIZED_DATA = 0x00000040;
  var SCN_MEM_READ = 0x40000000;

  /** Smallest multiple of `unit` that is >= n. */
  function alignUp(n, unit) {
    return Math.ceil(n / unit) * unit;
  }

  /**
   * .rsrc is already last: rebuild it in place at its own RVA and truncate
   * everything behind it (which is only ever padding, or a trailer from a
   * previous stamp that this one is about to replace anyway).
   */
  function rebuildLastSection(exe, info, icons, versionName, carry) {
    var last = info.sections[info.sections.length - 1];
    var section = buildResourceSection(icons, versionName, last.virtualAddress, carry);
    var padded = alignUp(section.length, info.fileAlignment);
    var out = new Uint8Array(last.rawOffset + padded);
    out.set(exe.subarray(0, last.rawOffset));
    out.set(section, last.rawOffset);

    var dv = new DataView(out.buffer);
    dv.setUint32(last.headerOffset + 8, section.length, true);   // VirtualSize (unpadded)
    dv.setUint32(last.headerOffset + 16, padded, true);          // SizeOfRawData (padded)
    dv.setUint32(
      info.sizeOfImageOffset,
      last.virtualAddress + alignUp(section.length, info.sectionAlignment),
      true
    );
    dv.setUint32(info.resourceDirEntry, last.virtualAddress, true);
    dv.setUint32(info.resourceDirEntry + 4, section.length, true);
    dv.setUint32(info.peOffset + 88, 0, true);                   // CheckSum
    return out;
  }

  /**
   * .rsrc is not last (MSVC puts .reloc behind it): growing it in place would
   * overwrite whatever follows, so the rebuilt section is appended as a new
   * one past the end of the image and data directory 2 is repointed at it.
   */
  function appendSection(exe, info, icons, versionName, carry) {
    var header = info.sectionTableOffset + info.numSections * 40;
    // The new header must fit in the padding between the section table and
    // the first byte of section data, both bounds, because SizeOfHeaders is
    // a declared value and the first raw offset is the physical one.
    var firstRaw = Infinity;
    var rawEnd = 0;
    var virtualEnd = 0;
    for (var i = 0; i < info.sections.length; i++) {
      var s = info.sections[i];
      if (s.rawOffset && s.rawSize) {
        if (s.rawOffset < firstRaw) firstRaw = s.rawOffset;
        rawEnd = Math.max(rawEnd, s.rawOffset + s.rawSize);
      }
      virtualEnd = Math.max(
        virtualEnd,
        s.virtualAddress + Math.max(s.virtualSize, s.rawSize)
      );
    }
    if (header + 40 > info.sizeOfHeaders || header + 40 > firstRaw) {
      throw new Error(
        "This stub cannot be stamped: its last section is \"" +
          info.sections[info.sections.length - 1].name +
          "\", not \".rsrc\", and the PE header has no room for another " +
          "section entry."
      );
    }

    var rva = alignUp(virtualEnd, info.sectionAlignment);
    var rawOffset = alignUp(rawEnd, info.fileAlignment);
    var section = buildResourceSection(icons, versionName, rva, carry);
    var padded = alignUp(section.length, info.fileAlignment);

    // Anything past rawEnd is not owned by a section (an old trailer, or the
    // padding a linker leaves) and is dropped, exactly as the in-place path
    // drops it.
    var out = new Uint8Array(rawOffset + padded);
    out.set(exe.subarray(0, Math.min(rawOffset, exe.length)));
    out.set(section, rawOffset);

    var dv = new DataView(out.buffer);
    var name = ".rsrc";
    for (var c = 0; c < 8; c++) {
      out[header + c] = c < name.length ? name.charCodeAt(c) : 0;
    }
    dv.setUint32(header + 8, section.length, true);  // VirtualSize
    dv.setUint32(header + 12, rva, true);            // VirtualAddress
    dv.setUint32(header + 16, padded, true);         // SizeOfRawData
    dv.setUint32(header + 20, rawOffset, true);      // PointerToRawData
    dv.setUint32(header + 24, 0, true);              // PointerToRelocations
    dv.setUint32(header + 28, 0, true);              // PointerToLinenumbers
    dv.setUint16(header + 32, 0, true);              // NumberOfRelocations
    dv.setUint16(header + 34, 0, true);              // NumberOfLinenumbers
    dv.setUint32(header + 36, SCN_CNT_INITIALIZED_DATA | SCN_MEM_READ, true);

    dv.setUint16(info.peOffset + 6, info.numSections + 1, true); // NumberOfSections
    dv.setUint32(
      info.sizeOfImageOffset,
      rva + alignUp(section.length, info.sectionAlignment),
      true
    );
    dv.setUint32(info.resourceDirEntry, rva, true);
    dv.setUint32(info.resourceDirEntry + 4, section.length, true);
    dv.setUint32(info.peOffset + 88, 0, true);                   // CheckSum
    return out;
  }

  function stamp(exe, icons, versionName) {
    var info = parse(exe);
    var last = info.sections[info.sections.length - 1];
    // Read the stub's own tree BEFORE anything is rewritten: rebuildLastSection
    // overwrites the very bytes these leaves point into.
    var carry = readResourceTree(exe, info);
    var out =
      last.name === ".rsrc"
        ? rebuildLastSection(exe, info, icons, versionName, carry)
        : appendSection(exe, info, icons, versionName, carry);

    // Self-check: the tree we just wrote must read back as the icons we were
    // given. A silent resource corruption would only show up as a blank icon
    // on the player's desktop, which is exactly the kind of bug that never
    // gets reported.
    if (icons.length) {
      var back = readIconGroup(out);
      if (back.length !== icons.length) {
        throw new Error("Icon stamping failed self-check: wrote " + icons.length +
          " icons, read back " + back.length + ".");
      }
      for (var i = 0; i < icons.length; i++) {
        if (back[i].bytes !== icons[i].png.length) {
          throw new Error("Icon stamping failed self-check at index " + i + ".");
        }
      }
    }
    return out;
  }

  root.PeResources = {
    parse: parse,
    buildResourceSection: buildResourceSection,
    readResourceTree: readResourceTree,
    readIconGroup: readIconGroup,
    stamp: stamp,
  };
})(typeof self !== "undefined" ? self : this);
