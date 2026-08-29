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
 * RFC 6902 JSON diff/apply used by the mod packager (app/create.html) to
 * store compact patch ops for data JSON files instead of a whole rewritten
 * file. Arrays are compared element-wise by index; any length change
 * replaces the whole array as a single "replace" op rather than emitting
 * index-shift-sensitive insert/remove ops. Mirrors the reference semantics
 * in .modding/tools/share-project.js's diffJson.
 */
(function (root) {
  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    var aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    var ak = Object.keys(a);
    var bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (var j = 0; j < ak.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(b, ak[j])) return false;
      if (!deepEqual(a[ak[j]], b[ak[j]])) return false;
    }
    return true;
  }

  // JSON Pointer (RFC 6901) escaping: "~" -> "~0" MUST happen before
  // "/" -> "~1", or a literal "~1" in a key would be mistaken for an
  // escaped "/" on unescape. unesc() below mirrors this in reverse order.
  function esc(token) {
    return String(token).split("~").join("~0").split("/").join("~1");
  }

  function unesc(token) {
    return token.split("~1").join("/").split("~0").join("~");
  }

  function walk(a, b, base, ops) {
    var aObj = a !== null && typeof a === "object";
    var bObj = b !== null && typeof b === "object";
    var aArr = Array.isArray(a);
    var bArr = Array.isArray(b);

    if (!aObj || !bObj || aArr !== bArr || (aArr && a.length !== b.length)) {
      if (!deepEqual(a, b)) ops.push({ op: "replace", path: base, value: b });
      return;
    }
    if (aArr) {
      for (var i = 0; i < a.length; i++) walk(a[i], b[i], base + "/" + i, ops);
      return;
    }
    var seen = Object.create(null);
    Object.keys(a).forEach(function (k) {
      seen[k] = true;
      if (!Object.prototype.hasOwnProperty.call(b, k)) {
        ops.push({ op: "remove", path: base + "/" + esc(k) });
      } else {
        walk(a[k], b[k], base + "/" + esc(k), ops);
      }
    });
    Object.keys(b).forEach(function (k) {
      if (!seen[k]) ops.push({ op: "add", path: base + "/" + esc(k), value: b[k] });
    });
  }

  function diff(a, b) {
    var ops = [];
    walk(a, b, "", ops);
    return ops;
  }

  function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  }

  function apply(a, ops) {
    var doc = { root: clone(a) };
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      var tokens = op.path === "" ? [] : op.path.split("/").slice(1).map(unesc);
      var parent = doc;
      var key = "root";
      for (var t = 0; t < tokens.length; t++) {
        parent = parent[key];
        key = Array.isArray(parent) ? parseInt(tokens[t], 10) : tokens[t];
      }
      if (op.op === "remove") {
        if (Array.isArray(parent)) parent.splice(key, 1);
        else delete parent[key];
      } else {
        parent[key] = clone(op.value);
      }
    }
    return doc.root;
  }

  root.JsonDiff = { diff: diff, apply: apply, deepEqual: deepEqual };
})(typeof self !== "undefined" ? self : this);
