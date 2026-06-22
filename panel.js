window.addEventListener('load', () => {
    const tbody = document.getElementById("results");
    const statusEl = document.getElementById("status");
    const findings = [];
    const addedKeys = new Set();      // for deduplication
    let isScanning = false;
    let debuggerReady = false;
    let listenerAttached = false;
    let rowCount = 0;

    // Map finding type → { icon, cssClass }
    function typeDisplay(type) {
        if (type === "postMessage(*)")    return { icon: "📡", cls: "type-postmessage" };
        if (type === "weak-origin-check") return { icon: "⚠️",  cls: "type-weakorigin"  };
        if (type.includes("unresolved") || type.includes("resolved"))
                                          return { icon: "🔍", cls: "type-unresolved"   };
        // message-listener (no origin check at all)
                                          return { icon: "👂", cls: "type-listener"     };
    }

    function setStatus(text, type = "info") {
        statusEl.textContent = text;
        statusEl.className = type; // "ok", "error", "info"
    }

    // Run `expression` in the inspected page's main world and return a Promise.
    // chrome.devtools.inspectedWindow.eval() is subject to the page's CSP, so on
    // CSP-locked pages it silently fails. When our debugger session is already
    // attached (scan is running) we instead call Runtime.evaluate directly over
    // CDP with allowUnsafeEvalBlockedByCSP — the same mechanism the real
    // DevTools Console uses to run typed-in code regardless of page CSP.
    async function runInInspectedPage(expression) {
        const target = { tabId: chrome.devtools.inspectedWindow.tabId };

        if (debuggerReady) {
            try {
                const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
                    expression,
                    allowUnsafeEvalBlockedByCSP: true,
                    replMode: true
                });
                if (res && res.exceptionDetails) {
                    throw new Error(res.exceptionDetails.text || "Runtime.evaluate threw");
                }
                return { ok: true };
            } catch (e) {
                // Fall through to inspectedWindow.eval below
            }
        }

        return new Promise((resolve) => {
            chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
                if (exceptionInfo) {
                    resolve({ ok: false, reason: exceptionInfo.description || exceptionInfo.value || "blocked, likely by page CSP" });
                } else {
                    resolve({ ok: true });
                }
            });
        });
    }

    // Source map cache: url -> parsed mappings (or null if unavailable)
    const sourceMapCache = {};

    // Fetch and parse the source map for a given JS url.
    // Returns an array of decoded VLQ segments or null.
    async function fetchSourceMap(jsUrl) {
        if (jsUrl in sourceMapCache) return sourceMapCache[jsUrl];
        sourceMapCache[jsUrl] = null; // mark as attempted

        try {
            const res = await fetch(jsUrl);
            if (!res.ok) return null;
            const text = await res.text();

            // Look for //# sourceMappingURL= at the end of the file
            const match = text.match(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/);
            if (!match) return null;

            let mapUrl = match[1];
            if (mapUrl.startsWith("data:")) {
                // Inline base64 source map
                const b64 = mapUrl.split(",")[1];
                const json = atob(b64);
                sourceMapCache[jsUrl] = JSON.parse(json);
                return sourceMapCache[jsUrl];
            }

            // Resolve relative URL against the JS file's URL
            mapUrl = new URL(mapUrl, jsUrl).href;
            const mapRes = await fetch(mapUrl);
            if (!mapRes.ok) return null;
            sourceMapCache[jsUrl] = await mapRes.json();
            return sourceMapCache[jsUrl];
        } catch (e) {
            return null;
        }
    }

    // Decode a single VLQ-encoded field (returns { value, rest })
    function decodeVLQ(str) {
        const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let result = 0, shift = 0, i = 0;
        while (i < str.length) {
            const digit = BASE64.indexOf(str[i++]);
            if (digit === -1) break;
            result |= (digit & 0x1f) << shift;
            shift += 5;
            if (!(digit & 0x20)) {
                const value = (result & 1) ? -(result >> 1) : (result >> 1);
                return { value, rest: str.slice(i) };
            }
        }
        return { value: 0, rest: "" };
    }

    // Given a source map and a 0-based (line, col), return original { source, line, col } or null.
    function resolveSourceMap(map, genLine, genCol) {
        if (!map || !map.mappings) return null;
        try {
            const lines = map.mappings.split(";");
            if (genLine >= lines.length) return null;

            // These accumulate deltas across ALL segments in the line
            let absGenCol = 0;
            let srcIndex = 0, srcLine = 0, srcCol = 0;
            let bestSeg = null;

            const segments = lines[genLine].split(",");
            for (const segStr of segments) {
                if (!segStr) continue;

                let s = segStr;
                // Field 0: generated column delta (always present)
                const f0 = decodeVLQ(s); s = f0.rest;
                absGenCol += f0.value;

                // Fields 1-3 are optional (present only when segment maps to a source)
                if (!s.length) continue;
                const f1 = decodeVLQ(s); s = f1.rest; srcIndex += f1.value;
                if (!s.length) continue;
                const f2 = decodeVLQ(s); s = f2.rest; srcLine  += f2.value;
                if (!s.length) continue;
                const f3 = decodeVLQ(s);               srcCol   += f3.value;

                // Keep the segment whose absGenCol is <= target and as large as possible
                if (absGenCol <= genCol) {
                    bestSeg = { absGenCol, srcIndex, srcLine, srcCol };
                }
            }

            if (!bestSeg) return null;
            const sources = map.sources || [];
            const sourceRoot = map.sourceRoot || "";
            const rawSrc = sources[bestSeg.srcIndex] || "unknown";
            const src = sourceRoot ? new URL(rawSrc, sourceRoot).href : rawSrc;
            return {
                source: src,
                line: bestSeg.srcLine + 1,  // 1-based for display
                col:  bestSeg.srcCol  + 1
            };
        } catch (e) {
            return null;
        }
    }

    function addFinding(f) {
        const col = f.col || 0;
        const key = `${f.type}|${f.url}|${f.line}|${col}|${f.details}`;
        if (addedKeys.has(key)) return;
        addedKeys.add(key);

        findings.push(f);

        rowCount++;
        const { icon, cls } = typeDisplay(f.type);
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="vuln-num">${rowCount}</td>
            <td class="vuln-type ${cls}"><span class="type-icon">${icon}</span><span class="type-label">${escapeHtml(f.type)}</span></td>
            <td class="vuln-url">${escapeHtml(f.url)}</td>
            <td class="vuln-line">${f.line}:${col}</td>
            <td class="vuln-details">${escapeHtml(f.details)}</td>
            <td><button class="btn-log" data-url="${escapeHtml(f.url)}" data-line="${f.line}" data-col="${col}" data-type="${escapeHtml(f.type)}" data-details="${escapeHtml(f.details)}">Log</button></td>
        `;

        const btn = tr.querySelector('.btn-log');
        btn.addEventListener('click', async function(e) {
            e.stopPropagation();
            const url = this.dataset.url;
            const line = parseInt(this.dataset.line, 10);
            const col  = parseInt(this.dataset.col, 10);
            const type = this.dataset.type;
            const details = this.dataset.details;

            // Try to resolve original source location via source map
            let location = `${url}:${line}:${col}`;
            let originalLocation = null;

            const map = await fetchSourceMap(url);
            if (map) {
                // AST loc is 1-based line, 0-based col; source map decode needs 0-based both
                const resolved = resolveSourceMap(map, line - 1, col);
                if (resolved) {
                    originalLocation = `${resolved.source}:${resolved.line}:${resolved.col}`;
                }
            }

            // V8/DevTools stack frames display columns 1-based; our AST column is
            // 0-based, so bump it by 1 only for the synthetic frame text below —
            // otherwise the click-through lands one character to the left.
            const stackLocation = `${url}:${line}:${col + 1}`;
            const stackOriginalLocation = originalLocation
                ? originalLocation.replace(/:(\d+)$/, (_, c) => `:${parseInt(c, 10) + 1}`)
                : null;

            const headline = `[ReconX] ${type} — ${details}`;
            const frameLabel = (type || "finding").replace(/[^\w.$]/g, "_") || "finding";
            const stackLines = [`Error: ${headline}`, `    at ${frameLabel} (${stackLocation})`];
            if (stackOriginalLocation) {
                stackLines.push(`    at ${frameLabel}_original (${stackOriginalLocation})`);
            }

            // Build a fake Error whose .stack we overwrite with our own frame(s).
            // Chrome's console parses the .stack STRING to render clickable
            // "at name (url:line:col)" links — it doesn't care that the Error
            // wasn't actually thrown there, which is exactly how tools like
            // DOM Invader get console entries to jump straight to a chosen
            // line/column instead of wherever console.error() itself was called.
            const evalCode = `
                (function() {
                    var e = new Error(${JSON.stringify(headline)});
                    e.stack = ${JSON.stringify(stackLines.join("\n"))};
                    console.error(e);
                })();
            `;

            const runResult = await runInInspectedPage(evalCode);
            if (!runResult.ok) {
                // Guaranteed-visible fallback if even the CSP-bypass path failed
                console.warn(`🔴 [ReconX] ${type} at ${originalLocation || location} — ${details}`);
                setStatus(`⚠️ Can't log into page console (${runResult.reason}). Location: ${originalLocation || location}`, "error");
            }
        });

        tbody.appendChild(tr);
    }

    function escapeHtml(unsafe) {
        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Chrome detaches the debugger on navigation/refresh — reattach automatically
    // so the user never has to click Start Scan twice.
    async function onDetach(source, reason) {
        if (source.tabId !== chrome.devtools.inspectedWindow.tabId) return;
        if (!debuggerReady) return; // user hasn't started a scan, ignore

        debuggerReady = false;
        setStatus("🔄 Reattaching after navigation...", "info");

        const target = { tabId: chrome.devtools.inspectedWindow.tabId };
        try {
            await chrome.debugger.attach(target, "1.3");
            // Same fix as startScan(): flip the ready flag before enable,
            // since enable replays scriptParsed for everything already on
            // the freshly-navigated page and that replay can arrive before
            // this command's own promise resolves.
            debuggerReady = true;
            await chrome.debugger.sendCommand(target, "Debugger.enable");
            setStatus("✅ Scanner active – listening for scripts", "ok");
        } catch (e) {
            // Tab may still be loading — retry once after a short delay
            setTimeout(async () => {
                try {
                    await chrome.debugger.attach(target, "1.3");
                    debuggerReady = true;
                    await chrome.debugger.sendCommand(target, "Debugger.enable");
                    setStatus("✅ Scanner active – listening for scripts", "ok");
                } catch (e2) {
                    setStatus("❌ Lost debugger connection – click Start Scan again", "error");
                    debuggerReady = false;
                }
            }, 500);
        }
    }

    chrome.debugger.onDetach.addListener(onDetach);

    async function onDebuggerEvent(source, method, params) {
        if (method !== "Debugger.scriptParsed") return;
        if (!debuggerReady) return;

        const target = { tabId: chrome.devtools.inspectedWindow.tabId };

        try {
            const result = await chrome.debugger.sendCommand(target, "Debugger.getScriptSource", {
                scriptId: params.scriptId
            });
            const found = scanSource(params.url, result.scriptSource);
            found.forEach(addFinding);
        } catch (e) {
            if (e.message && (e.message.includes("not attached") || e.message.includes("No script for id"))) {
                // ignore
            } else {
                console.warn("Script parse failed:", params.url, e);
            }
        }
    }

    async function startScan() {
        if (isScanning) return;
        isScanning = true;
        setStatus("Starting scanner...", "info");

        const target = { tabId: chrome.devtools.inspectedWindow.tabId };

        try {
            try { await chrome.debugger.detach(target); } catch (e) {}

            await chrome.debugger.attach(target, "1.3");

            // Listener + ready flag MUST be set up before Debugger.enable —
            // enabling replays a "Debugger.scriptParsed" event for every
            // script already on the page, and that replay fires immediately,
            // not after this command's promise resolves. Attaching the
            // listener afterward (as before) meant the entire initial batch
            // of already-loaded scripts was silently dropped, so the table
            // only ever filled in for scripts loaded after the scan started.
            if (!listenerAttached) {
                chrome.debugger.onEvent.addListener(onDebuggerEvent);
                listenerAttached = true;
            }
            debuggerReady = true;

            await chrome.debugger.sendCommand(target, "Debugger.enable");

            document.getElementById("start").disabled = true;
            document.getElementById("stop").disabled = false;

            setStatus("✅ Scanner active – listening for scripts", "ok");
            console.log("✅ PostMessage Scanner started successfully");
        } catch (e) {
            console.error("Debugger error:", e);
            setStatus("❌ Failed to start scanner – see console for details", "error");
            if (listenerAttached) {
                chrome.debugger.onEvent.removeListener(onDebuggerEvent);
                listenerAttached = false;
            }
            debuggerReady = false;
        } finally {
            isScanning = false;
        }
    }

    async function stopScan() {
        debuggerReady = false;

        if (listenerAttached) {
            chrome.debugger.onEvent.removeListener(onDebuggerEvent);
            listenerAttached = false;
        }

        const target = { tabId: chrome.devtools.inspectedWindow.tabId };
        try {
            await chrome.debugger.detach(target);
        } catch (e) {
            // Already detached — that's fine
        }

        document.getElementById("start").disabled = false;
        document.getElementById("stop").disabled = true;

        setStatus("🛑 Scanner stopped", "info");
        console.log("🛑 PostMessage Scanner stopped");
    }

    // Clean up when panel is closed
    window.addEventListener('unload', () => {
        debuggerReady = false;
        if (listenerAttached) {
            chrome.debugger.onEvent.removeListener(onDebuggerEvent);
            listenerAttached = false;
        }
        const target = { tabId: chrome.devtools.inspectedWindow.tabId };
        chrome.debugger.detach(target).catch(() => {});
        chrome.debugger.onDetach.removeListener(onDetach);
    });

    // Button handlers
    document.getElementById("start").onclick = startScan;
    document.getElementById("stop").onclick = stopScan;
    document.getElementById("clear").onclick = () => {
        findings.length = 0;
        addedKeys.clear();
        tbody.innerHTML = "";
        rowCount = 0;
        setStatus("", ""); // clear
    };
    document.getElementById("export").onclick = () => {
        if (findings.length === 0) return setStatus("No findings to export", "error");
        const blob = new Blob([JSON.stringify(findings, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = "postmessage-findings.json";
        a.click();
        // FIX: revoke object URL to avoid memory leak
        URL.revokeObjectURL(objectUrl);
        setStatus("✅ Exported successfully", "ok");
    };
});