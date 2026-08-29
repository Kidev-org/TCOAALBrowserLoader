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
/*
 * Translator-format dialogue parsers, shared by two consumers:
 *
 *   - lang-shim.js  (mod system): parses a translation's dialogue.csv/.txt into
 *     the cached CLD (__mod_lang_data__) at install / background-sync time.
 *   - index.html bootstrap: re-parses an already-installed translation BEFORE
 *     the engine loads, so a parser improvement (LANG_PARSE_VERSION bump) takes
 *     effect on the very launch the user reconnects, not the one after.
 *
 * It must stay dependency-free (no RPG Maker globals, no DOM) so the bootstrap
 * can load it before any engine script. Exposed as window.LangFormat.
 */
(function (root) {
  "use strict";

  // Schema version of the translator-format parsers (parseDialogueCsv /
  // parseDialogueTxt). Stamped into each translation's __mod_meta__ at install
  // time as `langParseVersion`. When the parsing logic changes in a way that
  // alters the produced CLD (linesLUT/labelLUT/...), bump this number: the next
  // launch re-parses already-installed .csv/.txt translations (from the file
  // already in IDB, no re-download) so the new parse takes effect without the
  // user reinstalling. The bootstrap applies it before boot; lang-shim's
  // background sync is the offline/late fallback.
  //
  //   1 -> original parsers
  //   2 -> Show-Choices entries (CSV "CHOICE(n)" rows / TXT [CHOICES] section)
  //        route to labelLUT instead of linesLUT, so choices get translated.
  var LANG_PARSE_VERSION = 2;

  function parseCsvLine(line) {
    var out = [];
    var buf = "";
    var i = 0;
    var inQ = false;
    while (i < line.length) {
      var c = line.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        buf += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === ",") {
        out.push(buf);
        buf = "";
        i++;
        continue;
      }
      buf += c;
      i++;
    }
    out.push(buf);
    return out;
  }

  /**
   * Parse a TCOAAL translator dialogue.csv into a lang-data object matching
   * the CLD schema ({ sysLabel, sysMenus, labelLUT, linesLUT }).
   *
   * The CSV is sectioned: each section begins after a blank row with a
   * header row naming the section, and rows inside the section describe
   * key -> translation mappings. We only consume sections that map cleanly
   * onto the CLD LUTs; other sections (Version, Language, Credits,
   * Descriptions, etc.) are ignored. Untranslated rows (empty translation
   * column) are skipped so the SW merge falls back to the base game.
   */
  function parseDialogueCsv(text) {
    var out = { sysLabel: {}, sysMenus: {}, labelLUT: {}, linesLUT: {} };
    if (!text) return out;
    // Normalize newlines, then walk logical CSV records (quotes can span lines).
    text = text.replace(/\r\n?/g, "\n");

    var records = [];
    var buf = "";
    var inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '"') {
        inQ = !inQ;
        buf += c;
        continue;
      }
      if (c === "\n" && !inQ) {
        records.push(buf);
        buf = "";
        continue;
      }
      buf += c;
    }
    if (buf.length) records.push(buf);

    var section = null; // "labels" | "menus" | "items" | "lines" | "language" | "version" | null
    for (var r = 0; r < records.length; r++) {
      var raw = records[r];
      if (!raw || raw.replace(/,+$/g, "").trim() === "") {
        section = null;
        continue;
      }
      var cells = parseCsvLine(raw);
      var c0 = (cells[0] || "").trim();
      // Section headers: only recognised at section boundaries (after
      // a blank line resets section=null). Otherwise "Language, Langue"
      // inside the Menus block would be mistaken for a header.
      if (section === null) {
        if (c0 === "Labels") {
          section = "labels";
          continue;
        }
        if (c0 === "Menus") {
          section = "menus";
          continue;
        }
        if (c0 === "Speakers" || c0 === "Items") {
          section = "items";
          continue;
        }
        if (c0 === "Descriptions") {
          section = "lines";
          continue;
        }
        if (c0 === "Language") {
          section = "language";
          continue;
        }
        if (c0 === "Version") {
          section = "version";
          continue;
        }
        if (c0 === "Section") {
          section = "lines";
          continue;
        }
      }
      if (section === "language") {
        // row shape: <langName>, <fontFile>, <fontSize>, ...
        if (!out.langName && c0) out.langName = c0;
        var ff = (cells[1] || "").trim();
        if (ff && !out.fontFace) out.fontFace = ff;
        var fs = parseInt((cells[2] || "").trim(), 10);
        if (!isNaN(fs) && !out.fontSize) out.fontSize = fs;
        section = null;
        continue;
      }
      if (section === "version") {
        if (!out.langVers && c0) out.langVers = c0;
        section = null;
        continue;
      }
      // Inside "Section" the following row is a column header (ID,Source,...)
      if (section === "lines" && c0 === "ID") continue;

      switch (section) {
        case "labels": {
          // key, English, Translation
          var lk = c0;
          var lt = (cells[2] || "").trim();
          if (lk && lt) out.sysLabel[lk] = lt;
          break;
        }
        case "menus": {
          // key, Translation, ...
          var mk = c0;
          var mt = (cells[1] || "").trim();
          if (mk && mt) out.sysMenus[mk] = mt;
          break;
        }
        case "items": {
          // hash, English, Translation
          var ik = c0;
          var it = (cells[2] || "").trim();
          if (ik && it) out.labelLUT[ik] = it;
          break;
        }
        case "lines": {
          // hash, Speaker, English, Translation
          var sh = c0;
          var tr = cells[3];
          if (!sh || tr == null || tr === "") break;
          // Show-Choices entries carry "CHOICE(n)" in the speaker column.
          // In the data they are "(label)[hash]" placeholders (RPG Maker
          // command 102), resolved at runtime via labelLUT NOT dialogue
          // lines. Routing them to linesLUT leaves labelLUT[hash] at the
          // untranslated base text, so the choice never gets translated.
          if (/^CHOICE\(\d+\)$/i.test((cells[1] || "").trim())) {
            out.labelLUT[sh] = tr;
            break;
          }
          if (!out.linesLUT[sh]) out.linesLUT[sh] = [];
          out.linesLUT[sh].push(tr);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Parse a TCOAAL translator dialogue.txt into a lang-data object. The
   * format uses [SECTION] headers followed by "key : value" lines; map
   * file sections ([CommonEvents.json], [Map###.json]) use "#hash (Speaker)"
   * block headers with one or more ": text" continuation lines. Blank
   * values skip the row so the SW merge falls back to the base game.
   */
  function parseDialogueTxt(text) {
    var out = { sysLabel: {}, sysMenus: {}, labelLUT: {}, linesLUT: {} };
    if (!text) return out;
    text = text.replace(/\r\n?/g, "\n");
    var lines = text.split("\n");

    var section = null; // "labels" | "menus" | "items" | "choices" | "lines" | "language" | "font" | null
    var curHash = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === "") {
        curHash = null;
        // [CHOICES] blocks are interspersed inside a map's dialogue (lines)
        // section, with no header to switch back afterwards. A blank line
        // ends the choices block, so revert to dialogue parsing.
        if (section === "choices") section = "lines";
        continue;
      }
      // Section header
      var m = line.match(/^\[([^\]]+)\]\s*$/);
      if (m) {
        curHash = null;
        var name = m[1];
        if (name === "LABELS") section = "labels";
        else if (name === "MENUS") section = "menus";
        else if (name === "SPEAKERS" || name === "ITEMS") section = "items";
        else if (name === "CHOICES") section = "choices";
        else if (/\.json$/i.test(name)) section = "lines";
        else if (name === "DESCRIPTIONS") section = "lines";
        else if (name === "LANGUAGE") section = "language";
        else if (name === "FONT") section = "font";
        else if (name === "VERSION") section = "version";
        else section = null;
        continue;
      }

      if (section === "language") {
        // Single free-form line = language display name
        if (!out.langName) out.langName = line.trim();
        continue;
      }

      if (section === "version") {
        if (!out.langVers) out.langVers = line.trim();
        continue;
      }

      if (section === "font") {
        var fkv = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
        if (fkv) {
          var fk = fkv[1].trim().toLowerCase();
          var fv = fkv[2].trim();
          // "File" in dialogue.txt is the font face name (matches
          // the base CLD's fontFace field, e.g. "GameFont").
          if (fk === "file" || fk === "face" || fk === "name") {
            if (fv) out.fontFace = fv;
          } else if (fk === "size") {
            var n = parseInt(fv, 10);
            if (!isNaN(n)) out.fontSize = n;
          }
        }
        continue;
      }

      if (section === "choices") {
        // "#hash : text": a Show-Choices label. In the data these are
        // "(label)[hash]" placeholders (RPG Maker command 102), resolved at
        // runtime via labelLUT, NOT linesLUT. Routing them anywhere else
        // leaves labelLUT[hash] at the untranslated base text.
        var chm = line.match(/^#([^\s(:]+)\s*:\s?(.*)$/);
        if (chm && chm[2] !== "") out.labelLUT[chm[1]] = chm[2];
        continue;
      }

      if (section === "lines") {
        // "#hash (Speaker)" opens a multi-line record with ": text" continuations.
        // "#hash : text" is a single-line record (common in CHOICES).
        var inline = line.match(/^#([^\s(:]+)\s*:\s?(.*)$/);
        if (inline) {
          var ih = inline[1];
          var iv = inline[2];
          if (iv !== "") {
            if (!out.linesLUT[ih]) out.linesLUT[ih] = [];
            out.linesLUT[ih].push(iv);
          }
          curHash = null;
          continue;
        }
        var hdr = line.match(/^#([^\s(]+)\s*(?:\([^)]*\))?\s*$/);
        if (hdr) {
          curHash = hdr[1];
          if (!out.linesLUT[curHash]) out.linesLUT[curHash] = [];
          continue;
        }
        var cont = line.match(/^:\s?(.*)$/);
        if (cont && curHash) {
          out.linesLUT[curHash].push(cont[1]);
          continue;
        }
        continue;
      }

      // Key/value sections: "#hash : value" or "key : value"
      var kv = line.match(/^\s*#?([^:]+?)\s*:\s*(.*)$/);
      if (!kv) continue;
      var key = kv[1].trim();
      var val = kv[2].trim();
      if (!key || !val) continue;

      switch (section) {
        case "labels":
          out.sysLabel[key] = val;
          break;
        case "menus":
          out.sysMenus[key] = val;
          break;
        case "items":
          out.labelLUT[key] = val;
          break;
      }
    }
    return out;
  }

  root.LangFormat = {
    LANG_PARSE_VERSION: LANG_PARSE_VERSION,
    parseCsvLine: parseCsvLine,
    parseDialogueCsv: parseDialogueCsv,
    parseDialogueTxt: parseDialogueTxt,
  };
})(typeof window !== "undefined" ? window : this);
