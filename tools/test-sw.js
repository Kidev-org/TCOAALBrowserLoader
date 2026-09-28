#!/usr/bin/env node
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
 * Runs app/sw.js's fetch handler against an in-memory IndexedDB that can be
 * told to fail, to pin down how the worker answers a store it cannot read.
 *
 * A failed read used to look exactly like a missing key: the request went on
 * to the network, which has no game files, and the page got a 404 that
 * AudioStreaming never retries. These tests hold the worker to the contract
 * the game's loaders need: a transient failure is retried in place, a
 * persistent one is a NETWORK ERROR (retryable by every loader), and only a
 * key that is really absent reaches the network.
 *
 * Run with: node tools/test-sw.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  \x1b[32mok\x1b[0m", name);
    passed++;
  } catch (e) {
    console.error("  \x1b[31mFAIL\x1b[0m", name);
    console.error("    ", e && e.stack ? e.stack : e);
    failed++;
  }
}
function eq(a, b, label) {
  if (a !== b) {
    throw new Error(
      `${label || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
    );
  }
}

// A minimal asynchronous IndexedDB: one database, one object store, string
// keys. `failures` decides per operation whether it errors.
function makeIdb(data) {
  const state = {
    data,
    gets: [],
    // (key) -> true to fail this get. Replaced by tests.
    failGet: () => false,
    closedConnections: new Set(),
    conns: [],
    opens: 0,
  };
  function request() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
  }
  function makeConn() {
    const conn = {
      onversionchange: null,
      onclose: null,
      transaction() {
        if (state.closedConnections.has(conn)) {
          const e = new Error("The database connection is closing.");
          e.name = "InvalidStateError";
          throw e;
        }
        const tx = { onabort: null, oncomplete: null, error: null };
        tx.objectStore = () => ({
          get(key) {
            const req = request();
            state.gets.push(key);
            setTimeout(() => {
              if (state.failGet(key)) {
                req.error = new Error("Failed to read large IndexedDB value");
                req.error.name = "UnknownError";
                const ev = { preventDefault() {} };
                if (req.onerror) req.onerror(ev);
                return;
              }
              req.result = Object.prototype.hasOwnProperty.call(state.data, key)
                ? state.data[key]
                : undefined;
              if (req.onsuccess) req.onsuccess();
            }, 1);
            return req;
          },
          openKeyCursor(range) {
            const req = request();
            const keys = Object.keys(state.data)
              .filter((k) => k >= range.lower && k <= range.upper)
              .sort();
            let i = 0;
            const step = () =>
              setTimeout(() => {
                req.result =
                  i < keys.length
                    ? { key: keys[i], continue: () => (i++, step()) }
                    : null;
                if (req.onsuccess) req.onsuccess();
              }, 1);
            step();
            return req;
          },
          put(value, key) {
            state.data[key] = value;
          },
          delete(key) {
            delete state.data[key];
          },
        });
        return tx;
      },
      close() {
        state.closedConnections.add(conn);
      },
    };
    state.conns.push(conn);
    return conn;
  }
  const indexedDB = {
    open() {
      state.opens++;
      const req = request();
      setTimeout(() => {
        req.result = makeConn();
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 1);
      return req;
    },
  };
  return { indexedDB, state };
}

// Load sw.js into a fresh context wired to that IDB and a network stub.
function loadWorker(data) {
  const idb = makeIdb(data);
  const listeners = {};
  const network = [];
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    Request,
    Response,
    Headers,
    TextEncoder,
    TextDecoder,
    Blob,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    Promise,
    crypto: globalThis.crypto,
    indexedDB: idb.indexedDB,
    IDBKeyRange: {
      bound: (lower, upper) => ({ lower, upper }),
    },
    caches: {
      open: async () => ({ match: async () => null, put: async () => {} }),
      match: async () => null,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async (req) => {
      network.push(typeof req === "string" ? req : req.url);
      return new Response("not found", { status: 404 });
    },
    location: { origin: "https://tcoaal.test" },
    clients: { claim: async () => {} },
    skipWaiting() {},
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  ctx.self = ctx;
  ctx.importScripts = (p) => {
    const src = fs.readFileSync(path.join(ROOT, "app", p), "utf8");
    vm.runInContext(src, ctx, { filename: p });
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "app/sw.js"), "utf8"), ctx, {
    filename: "sw.js",
  });

  function request(p) {
    const req = new Request("https://tcoaal.test/" + p);
    let answer = null;
    listeners.fetch({
      request: req,
      respondWith(r) {
        answer = Promise.resolve(r);
      },
    });
    if (!answer) throw new Error("the worker did not answer " + p);
    return answer;
  }
  function message(data) {
    listeners.message({ data, ports: [] });
  }
  return { request, message, idb: idb.state, network };
}

const SE_KEY = "audio/se/Door1.ogg";
const SE_BYTES = new Uint8Array([79, 103, 103, 83, 1, 2, 3]); // "OggS..."

(async () => {
  console.log("\nsw.js storage failures:");

  await test("a plain hit is served from IDB", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    const resp = await w.request(SE_KEY);
    eq(resp.status, 200);
    eq((await resp.arrayBuffer()).byteLength, SE_BYTES.length);
    eq(w.network.length, 0, "network requests");
  });

  await test("a read that fails once is retried in place", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    let failures = 1;
    w.idb.failGet = (k) => k === SE_KEY && failures-- > 0;
    const resp = await w.request(SE_KEY);
    eq(resp.status, 200);
    eq(w.network.length, 0, "network requests");
  });

  await test("a read that keeps failing is a network error, not a 404", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    w.idb.failGet = (k) => k === SE_KEY;
    const resp = await w.request(SE_KEY);
    eq(resp.type, "error");
    eq(resp.status, 0);
  });

  await test("a connection the browser closed is dropped and reopened", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    eq((await w.request(SE_KEY)).status, 200);
    w.message({ type: "resetGameCaches" }); // so the next answer needs IDB
    // Close the worker's handle behind its back, without onclose: the case
    // where a stale handle used to fail every read until a restart.
    for (const c of w.idb.conns) w.idb.closedConnections.add(c);
    const opens = w.idb.opens;
    const resp = await w.request(SE_KEY);
    eq(resp.status, 200);
    eq(w.idb.opens > opens, true, "reopened");
  });

  await test("a key that is really absent still reaches the network", async () => {
    const w = loadWorker({});
    const resp = await w.request("img/pictures/nothing.png");
    eq(resp.status, 404);
    eq(w.network.length > 0, true);
  });

  await test("a failed read of the active mod is retried by the next request", async () => {
    const MOD_KEY = "mod:MYMOD:" + SE_KEY;
    const w = loadWorker({
      __active_mod__: "MYMOD",
      [SE_KEY]: new Uint8Array([1]).buffer,
      [MOD_KEY]: SE_BYTES.buffer.slice(0),
    });
    let failing = true;
    w.idb.failGet = (k) => failing && k === "__active_mod__";
    const first = await w.request(SE_KEY);
    eq(first.type, "error", "first answer");
    failing = false;
    const second = await w.request(SE_KEY);
    eq(second.status, 200);
    // The mod's copy, not the base game's one-byte file.
    eq((await second.arrayBuffer()).byteLength, SE_BYTES.length);
  });

  console.log("\nsw.js decoded-media cache:");

  await test("a repeated sound is served without another IDB read", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    await (await w.request(SE_KEY)).arrayBuffer();
    const readsAfterFirst = w.idb.gets.filter((k) => k === SE_KEY).length;
    const again = await w.request(SE_KEY);
    eq(again.status, 200);
    eq((await again.arrayBuffer()).byteLength, SE_BYTES.length);
    eq(w.idb.gets.filter((k) => k === SE_KEY).length, readsAfterFirst);
  });

  await test("concurrent requests for one file share one read", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    const answers = await Promise.all([
      w.request(SE_KEY),
      w.request(SE_KEY),
      w.request(SE_KEY),
    ]);
    for (const a of answers) {
      eq(a.status, 200);
      eq((await a.arrayBuffer()).byteLength, SE_BYTES.length);
    }
    eq(w.idb.gets.filter((k) => k === SE_KEY).length, 1);
  });

  await test("switching the active mod drops the cache", async () => {
    const w = loadWorker({ [SE_KEY]: SE_BYTES.buffer.slice(0) });
    await (await w.request(SE_KEY)).arrayBuffer();
    w.message({ type: "setActiveMod", id: "OTHER" });
    const n = w.idb.gets.length;
    await (await w.request(SE_KEY)).arrayBuffer();
    eq(w.idb.gets.length > n, true, "read again");
  });

  await test("a 404 is not cached", async () => {
    const w = loadWorker({});
    eq((await w.request("audio/se/Missing.ogg")).status, 404);
    eq((await w.request("audio/se/Missing.ogg")).status, 404);
    eq(w.network.length, 2);
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
