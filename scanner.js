// scanner.js — postMessage/addEventListener("message") static analyser
// Uses Babel.packages.traverse + Babel.packages.types from babel.min.js (standalone v8)
// Falls back to manual acorn-loose walk if Babel is unavailable.

// ─── parser ──────────────────────────────────────────────────────────────────

function parseSource(source) {
    if (!source || !source.trim()) {
        console.warn("⚠️ Skipping empty script");
        return null;
    }

    let babelParse = null;
    if (typeof Babel !== 'undefined') {
        if (typeof Babel.parse === 'function') {
            babelParse = (src, opts) => Babel.parse(src, opts);
        } else if (Babel.packages?.parser?.parse) {
            babelParse = (src, opts) => Babel.packages.parser.parse(src, opts);
        } else if (Babel.parser?.parse) {
            babelParse = (src, opts) => Babel.parser.parse(src, opts);
        }
    }

    if (babelParse) {
        try {
            const ast = babelParse(source, {
                sourceType: "unambiguous",
                errorRecovery: true,
                plugins: ["jsx", "typescript"]
            });
            console.log("✅ Babel parsed successfully");
            return { ast, parser: "babel" };
        } catch (e) {
            console.warn("Babel parsing failed:", e.message);
        }
    } else {
        console.warn("Babel not available");
    }

    if (typeof acornLoose !== 'undefined' && typeof acornLoose.parse === 'function') {
        try {
            const ast = acornLoose.parse(source, { ecmaVersion: "latest", locations: true });
            console.log("✅ Acorn-loose parsed successfully");
            return { ast, parser: "acorn" };
        } catch (e) {
            console.error("❌ Acorn-loose failed:", e.message);
        }
    }

    console.error("❌ No parser could process this script");
    return null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function getStringValue(node) {
    if (!node) return null;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    return null;
}

// ─── shared analysis helpers (used by both Babel and Acorn paths) ─────────────

// Spoofable string/regex methods used on e.origin
const WEAK_ORIGIN_METHODS = new Set([
    "includes", "indexOf", "lastIndexOf",
    "startsWith", "endsWith",
    "match", "matchAll", "search",
    "split", "slice", "substring", "substr"
]);




// Returns true if `node` is an access to the message event's .origin property.
// Matches: eventParam.origin only (strict — avoids location.origin false positives).
// Also matches: this.event.origin / window.event.origin when param is named "event" etc.
function isOriginAccess(node, eventParam) {
    if (!node || node.type !== "MemberExpression" || node.computed) return false;
    if (node.property?.name !== "origin") return false;
    const obj = node.object;
    if (!obj) return false;

    // Direct: e.origin (only if object name matches the event param)
    if (obj.type === "Identifier" && obj.name === eventParam) return true;

    // Chained: this.event.origin / window.event.origin / self.event.origin
    // The intermediate property name must match the param name
    if (
        obj.type === "MemberExpression" &&
        !obj.computed &&
        obj.property?.type === "Identifier" &&
        obj.property.name === eventParam
    ) {
        const g = obj.object;
        if (
            g?.type === "ThisExpression" ||
            (g?.type === "Identifier" && ["window", "self", "globalThis"].includes(g.name))
        ) return true;
    }

    return false;
}

// Given an origin-access node and its immediate AST parent, returns the
// weak method name if spoofable, or null if it's a safe strict equality check.
function getWeakOriginMethod(originNode, parent) {
    if (!parent) return null;

    // e.origin.method(...)
    if (
        parent.type === "MemberExpression" &&
        parent.object === originNode &&
        !parent.computed &&
        parent.property?.type === "Identifier" &&
        WEAK_ORIGIN_METHODS.has(parent.property.name)
    ) return parent.property.name;

    // /re/.test(e.origin)
    if (
        parent.type === "CallExpression" &&
        parent.callee?.type === "MemberExpression" &&
        parent.callee.property?.name === "test" &&
        Array.isArray(parent.arguments) &&
        parent.arguments.some(a => a === originNode)
    ) return "RegExp.test";

    // unknownFn(e.origin) — conservative flag (not a safe equality check)
    if (
        parent.type === "CallExpression" &&
        Array.isArray(parent.arguments) &&
        parent.arguments.some(a => a === originNode) &&
        parent.callee !== originNode
    ) {
        const cn =
            parent.callee?.type === "Identifier" ? parent.callee.name :
            parent.callee?.property?.name ?? null;
        if (cn && !["log", "warn", "error", "assert", "info", "debug"].includes(cn))
            return `function call (${cn})`;
    }

    return null;
}



// Analyse a handler function body for origin-check completeness.
// Reports: missing origin check, weak origin check method.
// Does NOT report sinks — only listener/origin issues.
function analyseHandlerBody(fnNode, addFinding, line, col) {
    const params = fnNode.params || [];

    let eventParam = null;
    let isDestructured = false;

    for (const p of params) {
        if (p.type === "Identifier") { eventParam = p.name; break; }
        if (p.type === "ObjectPattern") { isDestructured = true; break; }
    }

    if (!eventParam && !isDestructured) {
        addFinding("message-listener", line, col, "Handler has no identifiable event parameter");
        return;
    }

    if (isDestructured) {
        addFinding("message-listener", line, col, "Handler uses destructured param — origin check could not be verified");
        return;
    }

    let usesOrigin = false;
    let weakMethod = null;

    function walk(node, parent) {
        if (!node || typeof node !== "object") return;
        if (isOriginAccess(node, eventParam)) {
            usesOrigin = true;
            const wm = getWeakOriginMethod(node, parent);
            if (wm && !weakMethod) weakMethod = wm;
            return;
        }
        for (const key of Object.keys(node)) {
            if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
            const val = node[key];
            if (Array.isArray(val)) {
                for (const c of val) { if (c && typeof c === "object" && c.type) walk(c, node); }
            } else if (val && typeof val === "object" && val.type) {
                walk(val, node);
            }
        }
    }
    walk(fnNode, null);

    if (!usesOrigin) {
        addFinding("message-listener", line, col, "No event.origin check");
    } else if (weakMethod) {
        addFinding("weak-origin-check", line, col,
            `Origin check uses '${weakMethod}' — spoofable via partial matching`);
    }
}

// ─── Babel-traverse based scanner ────────────────────────────────────────────

function scanWithBabelTraverse(ast, url, findings) {
    const traverse = Babel.packages.traverse.default;
    const t        = Babel.packages.types;

    const seen = new Set();
    function addFinding(type, line, col, details) {
        const key = `${type}|${line}|${col}|${details}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({ type, url, line, col, details });
    }

    // Resolve a handler node (identifier / member / bound) to its function AST node.
    function resolveHandlerNode(handlerNode, scopePath) {
        // Unwrap .bind(ctx)
        if (
            t.isCallExpression(handlerNode) &&
            t.isMemberExpression(handlerNode.callee) &&
            t.isIdentifier(handlerNode.callee.property, { name: "bind" })
        ) {
            handlerNode = handlerNode.callee.object;
        }

        // Inline function / arrow
        if (t.isFunction(handlerNode) || ["FunctionExpression","ArrowFunctionExpression","FunctionDeclaration"].includes(handlerNode?.type)) {
            return { fnNode: handlerNode, ambiguous: false };
        }

        // Bare identifier
        if (t.isIdentifier(handlerNode)) {
            const binding = scopePath.scope.getBinding(handlerNode.name);
            if (!binding) return { fnNode: null, ambiguous: false, name: handlerNode.name };

            if (binding.constantViolations.length > 0) {
                const allFns = [];
                const initNode = binding.path.node.init || binding.path.node;
                if (t.isFunction(initNode)) allFns.push(initNode);
                for (const vp of binding.constantViolations) {
                    if (t.isAssignmentExpression(vp.node) && t.isFunction(vp.node.right)) {
                        allFns.push(vp.node.right);
                    }
                }
                return { fnNode: null, ambiguous: true, name: handlerNode.name, allFns };
            }

            const declNode = binding.path.node;
            if (t.isFunctionDeclaration(declNode) || t.isFunction(declNode)) {
                return { fnNode: declNode, ambiguous: false };
            }
            if (t.isVariableDeclarator(declNode) && t.isFunction(declNode.init)) {
                return { fnNode: declNode.init, ambiguous: false };
            }
            return { fnNode: null, ambiguous: false, name: handlerNode.name };
        }

        // obj.method
        if (t.isMemberExpression(handlerNode) && !handlerNode.computed) {
            const objName  = t.isIdentifier(handlerNode.object)  ? handlerNode.object.name  : null;
            const propName = t.isIdentifier(handlerNode.property) ? handlerNode.property.name : null;
            if (!objName || !propName) return { fnNode: null, ambiguous: false };

            const binding = scopePath.scope.getBinding(objName);
            if (!binding) return { fnNode: null, ambiguous: false, name: `${objName}.${propName}` };

            const declNode = binding.path.node;
            if (t.isVariableDeclarator(declNode) && t.isObjectExpression(declNode.init)) {
                const prop = declNode.init.properties.find(p =>
                    (t.isObjectProperty(p) || p.type === "Property") &&
                    t.isIdentifier(p.key, { name: propName }) &&
                    t.isFunction(p.value)
                );
                if (prop) return { fnNode: prop.value, ambiguous: false };
            }
            return { fnNode: null, ambiguous: false, name: `${objName}.${propName}` };
        }

        // CallExpression handler result (e.g. getHandler()) — can't resolve
        if (t.isCallExpression(handlerNode)) {
            return { fnNode: null, ambiguous: false, name: "(CallExpression result)" };
        }

        return { fnNode: null, ambiguous: false };
    }

    function dispatchHandler(handlerNode, scopePath, line, col) {
        const result = resolveHandlerNode(handlerNode, scopePath);

        if (result.ambiguous) {
            if (result.allFns && result.allFns.length > 0) {
                addFinding("message-listener", line, col,
                    `Handler '${result.name}' has multiple assignments — analysing all branches`);
                for (const fn of result.allFns) analyseHandlerBody(fn, addFinding, line, col);
            } else {
                addFinding("message-listener", line, col,
                    `Handler '${result.name}' is conditionally assigned — could not fully resolve`);
            }
            return;
        }

        if (result.fnNode) {
            analyseHandlerBody(result.fnNode, addFinding, line, col);
            return;
        }

        const label = result.name ? `Handler '${result.name}'` : "Handler";
        addFinding("message-listener", line, col,
            `${label} could not be statically resolved (possibly imported or dynamic)`);
    }

    // Resolve event type arg: literal string OR scope-bound variable
    function resolveEventType(argNode, scopePath) {
        const sv = getStringValue(argNode);
        if (sv !== null) return sv;
        if (t.isIdentifier(argNode)) {
            const binding = scopePath.scope.getBinding(argNode.name);
            if (binding) {
                const init = binding.path.node.init;
                return getStringValue(init);
            }
        }
        return null;
    }

    // ── generalised constant-folding / alias resolver ──────────────────────
    // Resolves a NodePath to a best-effort static value: a string, or a
    // function definition (so callers can "invoke" it and resolve further).
    // Handles: literals, no-substitution template literals, identifier →
    // binding (init + every reassignment, followed recursively through
    // arbitrary-length chains), string concatenation, String.fromCharCode,
    // array/object literal indexing (incl. dynamic keys), and IIFEs /
    // function calls whose body is a single trivial return.
    function resolveValue(path, depth) {
        depth = depth || 0;
        if (!path || !path.node || depth > 10) return null;
        const node = path.node;

        const sv = getStringValue(node);
        if (sv !== null) return { kind: "string", value: sv };

        if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
            return { kind: "string", value: node.quasis.map(q => q.value.cooked).join("") };
        }

        if (t.isFunction(node)) return { kind: "function", path };
        if (t.isObjectExpression(node)) return { kind: "object", path };
        if (t.isArrayExpression(node)) return { kind: "array", path };

        if (t.isConditionalExpression(node)) {
            const c = resolveValue(path.get("consequent"), depth + 1);
            if (c) return c;
            return resolveValue(path.get("alternate"), depth + 1);
        }

        if (t.isBinaryExpression(node) && node.operator === "+") {
            const l = resolveValue(path.get("left"), depth + 1);
            const r = resolveValue(path.get("right"), depth + 1);
            if (l && l.kind === "string" && r && r.kind === "string") {
                return { kind: "string", value: l.value + r.value };
            }
            return null;
        }

        if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
            // String.fromCharCode(...) — including multi-arg
            if (
                t.isMemberExpression(node.callee) &&
                t.isIdentifier(node.callee.object, { name: "String" }) &&
                t.isIdentifier(node.callee.property, { name: "fromCharCode" })
            ) {
                const codes = node.arguments.map(a => (t.isNumericLiteral(a) ? a.value : null));
                if (codes.length && codes.every(c => c !== null)) {
                    return { kind: "string", value: codes.map(c => String.fromCharCode(c)).join("") };
                }
                return null;
            }

            // Resolve callee to a function definition, then evaluate what it returns
            const calleeVal = resolveValue(path.get("callee"), depth + 1);
            if (calleeVal && calleeVal.kind === "function") {
                return resolveFunctionReturn(calleeVal.path, depth + 1);
            }
            return null;
        }

        if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
            const objVal = resolveValue(path.get("object"), depth + 1);
            if (!objVal || (objVal.kind !== "object" && objVal.kind !== "array")) return null;

            let propKey = null;
            if (!node.computed) {
                propKey = t.isIdentifier(node.property) ? node.property.name : null;
            } else if (t.isStringLiteral(node.property) || t.isNumericLiteral(node.property)) {
                propKey = String(node.property.value);
            } else {
                const kv = resolveValue(path.get("property"), depth + 1);
                if (kv && kv.kind === "string") propKey = kv.value;
            }
            if (propKey === null) return null;

            if (objVal.kind === "array") {
                if (!/^\d+$/.test(propKey)) return null;
                const elPath = objVal.path.get(`elements.${propKey}`);
                return elPath && elPath.node ? resolveValue(elPath, depth + 1) : null;
            }

            const props = objVal.path.get("properties");
            for (const p of props) {
                if (!p.isObjectProperty || !p.isObjectProperty()) continue;
                const k = p.node.key;
                let kName = null;
                if (t.isIdentifier(k) && !p.node.computed) kName = k.name;
                else if (t.isStringLiteral(k)) kName = k.value;
                else if (t.isNumericLiteral(k)) kName = String(k.value);
                if (kName === propKey) return resolveValue(p.get("value"), depth + 1);
            }
            return null;
        }

        if (t.isIdentifier(node)) {
            const binding = path.scope.getBinding(node.name);
            if (!binding || !binding.path) return null;

            const bNode = binding.path.node;
            if (t.isFunctionDeclaration(bNode)) return { kind: "function", path: binding.path };

            if (t.isVariableDeclarator(bNode) && bNode.init) {
                const v = resolveValue(binding.path.get("init"), depth + 1);
                if (v) return v;
            }
            // Walk every reassignment too — a variable that's EVER set to "*"
            // is worth flagging even if its declared init wasn't.
            for (const vp of (binding.constantViolations || [])) {
                if (t.isAssignmentExpression(vp.node) && vp.node.right) {
                    const v = resolveValue(vp.get("right"), depth + 1);
                    if (v) return v;
                }
            }
            return null;
        }

        return null;
    }

    // Resolve what calling a given function (NodePath to a Function node)
    // returns, by evaluating its single trivial return / expression body.
    function resolveFunctionReturn(fnPath, depth) {
        const node = fnPath.node;
        if (!t.isFunction(node)) return null;
        const bodyPath = fnPath.get("body");
        if (!bodyPath.isBlockStatement || !bodyPath.isBlockStatement()) {
            return resolveValue(bodyPath, depth + 1); // arrow expression body
        }
        const stmts = bodyPath.get("body");
        for (const s of stmts) {
            if (s.isReturnStatement && s.isReturnStatement() && s.node.argument) {
                return resolveValue(s.get("argument"), depth + 1);
            }
        }
        return null;
    }

    // True if `path` is `fn => fn` / `function(fn){ return fn; }` — a
    // pass-through wrapper, the shape used to launder a postMessage
    // reference through an extra call layer.
    function isIdentityFunction(path, depth) {
        depth = depth || 0;
        if (!path || !path.node || depth > 5) return false;
        const node = path.node;

        if (t.isIdentifier(node)) {
            const binding = path.scope.getBinding(node.name);
            if (binding && binding.path) {
                if (t.isFunctionDeclaration(binding.path.node)) return isIdentityFunction(binding.path, depth + 1);
                if (t.isVariableDeclarator(binding.path.node) && t.isFunction(binding.path.node.init)) {
                    return isIdentityFunction(binding.path.get("init"), depth + 1);
                }
            }
            return false;
        }

        if (!t.isFunction(node) || node.params.length !== 1 || !t.isIdentifier(node.params[0])) return false;
        const paramName = node.params[0].name;

        if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
            return t.isIdentifier(node.body, { name: paramName });
        }
        if (t.isBlockStatement(node.body) && node.body.body.length === 1 && t.isReturnStatement(node.body.body[0])) {
            return t.isIdentifier(node.body.body[0].argument, { name: paramName });
        }
        return false;
    }

    // True if `path` denotes a reference to window.postMessage (directly,
    // through .bind(), or through an arbitrary chain of variable aliasing).
    function calleeIsPostMessage(calleePath, depth) {
        depth = depth || 0;
        if (!calleePath || !calleePath.node || depth > 10) return false;
        const node = calleePath.node;

        if (t.isIdentifier(node, { name: "postMessage" })) return true;

        if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
            if (!node.computed && t.isIdentifier(node.property, { name: "postMessage" })) return true;
            if (node.computed) {
                const v = resolveValue(calleePath.get("property"), depth + 1);
                if (v && v.kind === "string" && v.value === "postMessage") return true;
            }
            return false;
        }

        // .bind(ctx) unwrap — applies to plain calls and optional calls alike
        if (
            (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
            t.isMemberExpression(node.callee) &&
            t.isIdentifier(node.callee.property, { name: "bind" })
        ) {
            return calleeIsPostMessage(calleePath.get("callee.object"), depth + 1);
        }

        // identifier alias: const pm = <postMessage ref>; ... pm(...)
        if (t.isIdentifier(node)) {
            const binding = calleePath.scope.getBinding(node.name);
            if (!binding || !binding.path) return false;
            if (t.isVariableDeclarator(binding.path.node) && binding.path.node.init) {
                if (calleeIsPostMessage(binding.path.get("init"), depth + 1)) return true;
            }
            for (const vp of (binding.constantViolations || [])) {
                if (t.isAssignmentExpression(vp.node) && vp.node.right) {
                    if (calleeIsPostMessage(vp.get("right"), depth + 1)) return true;
                }
            }
            return false;
        }

        // identity-wrapper laundering: wrap(<postMessage ref>)(...)
        if (t.isCallExpression(node)) {
            const wrapperCalleePath = calleePath.get("callee");
            if (isIdentityFunction(wrapperCalleePath)) {
                const argPaths = calleePath.get("arguments");
                for (const ap of argPaths) {
                    if (calleeIsPostMessage(ap, depth + 1)) return true;
                }
            }
            return false;
        }

        return false;
    }

    // Check a resolved origin-arg NodePath for a wildcard, optionally
    // labelling how it was reached (.call / .apply / Reflect.apply).
    function checkPostMessageWildcardArgs(originArgPath, line, col, label) {
        if (!originArgPath || !originArgPath.node) return;
        const resolved = resolveValue(originArgPath, 0);
        if (resolved && resolved.kind === "string" && resolved.value === "*") {
            addFinding("postMessage(*)", line, col, `Wildcard targetOrigin${label ? " " + label : ""} (resolved to literal '*')`);
            return;
        }
        // Ternaries: resolveValue collapses to one branch, so explicitly
        // probe both — `cond ? safe : "*"` shouldn't be missed.
        if (t.isConditionalExpression(originArgPath.node)) {
            const c = resolveValue(originArgPath.get("consequent"), 0);
            const a = resolveValue(originArgPath.get("alternate"), 0);
            if ((c && c.kind === "string" && c.value === "*") || (a && a.kind === "string" && a.value === "*")) {
                addFinding("postMessage(*)", line, col, `Wildcard targetOrigin${label ? " " + label : ""} (one branch of a conditional resolves to '*')`);
            }
        }
    }

    function checkPostMessageWildcard(path) {
        const originArgPath = path.get("arguments.1");
        const line = path.node.loc?.start?.line  || 0;
        const col  = path.node.loc?.start?.column || 0;
        checkPostMessageWildcardArgs(originArgPath, line, col, null);
    }

    traverse(ast, {
        "CallExpression|OptionalCallExpression"(path) {
            const callee = path.node.callee;
            const args   = path.node.arguments;
            const line   = path.node.loc?.start?.line  || 0;
            const col    = path.node.loc?.start?.column || 0;

            // Direct / aliased / wrapped / bound / computed-property postMessage(..., origin)
            if (calleeIsPostMessage(path.get("callee"))) {
                checkPostMessageWildcard(path);
            }

            // fnRef.call(thisArg, msg, origin) / fnRef.apply(thisArg, [msg, origin])
            // — indirect dispatch through Function.prototype.
            if (t.isMemberExpression(callee) && !callee.computed) {
                const isCall  = t.isIdentifier(callee.property, { name: "call" });
                const isApply = t.isIdentifier(callee.property, { name: "apply" });
                if ((isCall || isApply) && calleeIsPostMessage(path.get("callee.object"))) {
                    if (isCall && args.length >= 3) {
                        checkPostMessageWildcardArgs(path.get("arguments.2"), line, col, "(via .call)");
                    } else if (isApply && args.length >= 2 && t.isArrayExpression(args[1])) {
                        checkPostMessageWildcardArgs(path.get("arguments.1.elements.1"), line, col, "(via .apply)");
                    }
                }
            }
            // Reflect.apply(fnRef, thisArg, [msg, origin])
            if (
                t.isMemberExpression(callee) && !callee.computed &&
                t.isIdentifier(callee.object, { name: "Reflect" }) &&
                t.isIdentifier(callee.property, { name: "apply" }) &&
                args.length >= 3 && calleeIsPostMessage(path.get("arguments.0")) &&
                t.isArrayExpression(args[2])
            ) {
                checkPostMessageWildcardArgs(path.get("arguments.2.elements.1"), line, col, "(via Reflect.apply)");
            }

            // Dynamic code construction — can't statically parse a runtime
            // string without re-invoking the whole pipeline, so heuristically
            // flag it for manual review instead of silently skipping it.
            if (t.isIdentifier(callee, { name: "eval" }) && args[0]) {
                const sv = getStringValue(args[0]);
                if (sv && /postMessage/.test(sv)) {
                    addFinding("postMessage(*)", line, col,
                        "eval() body references postMessage — contents not statically analysed, verify manually");
                }
            }

            // addEventListener("message", handler)  — both .addEventListener and ["addEventListener"]
            const isAddEL =
                t.isMemberExpression(callee) &&
                (
                    t.isIdentifier(callee.property, { name: "addEventListener" }) ||
                    (callee.computed && getStringValue(callee.property) === "addEventListener")
                );

            if (isAddEL && args.length >= 2) {
                const eventType = resolveEventType(args[0], path);
                if (eventType === "message") {
                    dispatchHandler(args[1], path, line, col);
                }
            }
        },

        NewExpression(path) {
            // new Function("a","b","window.postMessage(a,b)") — same caveat as eval() above.
            if (t.isIdentifier(path.node.callee, { name: "Function" })) {
                const line = path.node.loc?.start?.line  || 0;
                const col  = path.node.loc?.start?.column || 0;
                const bodyArg = path.node.arguments[path.node.arguments.length - 1];
                const sv = getStringValue(bodyArg);
                if (sv && /postMessage/.test(sv)) {
                    addFinding("postMessage(*)", line, col,
                        "new Function(...) body references postMessage — contents not statically analysed, verify manually");
                }
            }
        },

        AssignmentExpression(path) {
            const { left, right } = path.node;
            const line = path.node.loc?.start?.line  || 0;
            const col  = path.node.loc?.start?.column || 0;

            // ANY .onmessage = fn (not just window/self/globalThis)
            const isOnmessageProp =
                t.isMemberExpression(left) &&
                t.isIdentifier(left.property, { name: "onmessage" });
            const isOnmessageBare =
                t.isIdentifier(left, { name: "onmessage" });

            if (isOnmessageProp || isOnmessageBare) {
                dispatchHandler(right, path, line, col);
            }
        }
    });
}

// ─── Acorn fallback scanner ───────────────────────────────────────────────────

function scanWithAcornWalk(ast, url, findings) {
    const seen = new Set();
    function addFinding(type, line, col, details) {
        const key = `${type}|${line}|${col}|${details}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({ type, url, line, col, details });
    }

    const namedFunctions  = {};
    const objectMethods   = {};
    const deferredHandlers = [];
    const stringScope     = {}; // variable name → string literal value (for event-type resolution)
    const objectScope     = {}; // variable name → ObjectExpression node
    const arrayScope      = {}; // variable name → ArrayExpression node
    const postMessageAliases = new Set(); // variable names known to alias window.postMessage

    const FUNCTION_TYPES = new Set([
        "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"
    ]);

    function getEventParam(fnNode) {
        for (const p of (fnNode.params || [])) {
            if (p.type === "Identifier") return p.name;
        }
        return null;
    }

    function resolveStringVar(node) {
        const sv = getStringValue(node);
        if (sv !== null) return sv;
        if (node?.type === "Identifier" && stringScope[node.name] !== undefined) {
            return stringScope[node.name];
        }
        return null;
    }

    // ── generalised constant-folding resolver (flat, best-effort) ──────────
    // No real scope analysis here (acorn-loose path only) — this is a single
    // forward pass relying on declarations appearing before use, same
    // philosophy as the rest of this fallback ("keep flat for simplicity").
    // Handles: literals, template literals, binary concat, multi-hop
    // identifier chains, String.fromCharCode, array/object literal indexing,
    // and IIFEs / function calls with a single trivial return.
    function resolveConst(node, depth) {
        depth = depth || 0;
        if (!node || depth > 10) return null;

        const sv = getStringValue(node);
        if (sv !== null) return { kind: "string", value: sv };

        if (node.type === "TemplateLiteral" && (!node.expressions || node.expressions.length === 0)) {
            return { kind: "string", value: node.quasis.map(q => q.value.cooked).join("") };
        }

        if (FUNCTION_TYPES.has(node.type)) return { kind: "function", node };
        if (node.type === "ObjectExpression") return { kind: "object", node };
        if (node.type === "ArrayExpression") return { kind: "array", node };

        if (node.type === "ConditionalExpression") {
            const c = resolveConst(node.consequent, depth + 1);
            if (c) return c;
            return resolveConst(node.alternate, depth + 1);
        }

        if (node.type === "BinaryExpression" && node.operator === "+") {
            const l = resolveConst(node.left, depth + 1);
            const r = resolveConst(node.right, depth + 1);
            if (l && l.kind === "string" && r && r.kind === "string") return { kind: "string", value: l.value + r.value };
            return null;
        }

        if (node.type === "CallExpression") {
            if (
                node.callee?.type === "MemberExpression" &&
                node.callee.object?.type === "Identifier" && node.callee.object.name === "String" &&
                node.callee.property?.type === "Identifier" && node.callee.property.name === "fromCharCode"
            ) {
                const codes = (node.arguments || []).map(a => (typeof a.value === "number" ? a.value : null));
                if (codes.length && codes.every(c => c !== null)) {
                    return { kind: "string", value: codes.map(c => String.fromCharCode(c)).join("") };
                }
                return null;
            }
            const calleeVal = resolveConst(node.callee, depth + 1);
            if (calleeVal && calleeVal.kind === "function") return resolveFunctionReturnFlat(calleeVal.node, depth + 1);
            return null;
        }

        if (node.type === "MemberExpression") {
            const objVal = resolveConst(node.object, depth + 1);
            if (!objVal || (objVal.kind !== "object" && objVal.kind !== "array")) return null;

            let propKey = null;
            if (!node.computed) {
                propKey = node.property?.type === "Identifier" ? node.property.name : null;
            } else {
                // String/numeric literal directly (most common for ["x"] and [1] indexing)
                if (node.property?.type === "Literal") {
                    propKey = String(node.property.value); // works for both string and numeric
                } else {
                    const kv = resolveConst(node.property, depth + 1);
                    if (kv && kv.kind === "string") propKey = kv.value;
                }
            }
            if (propKey === null) return null;

            if (objVal.kind === "array") {
                if (!/^\d+$/.test(propKey)) return null;
                const el = objVal.node.elements[Number(propKey)];
                return el ? resolveConst(el, depth + 1) : null;
            }
            for (const prop of (objVal.node.properties || [])) {
                if (prop.type !== "Property") continue;
                let kName = null;
                if (!prop.computed && prop.key?.type === "Identifier") kName = prop.key.name;
                else if (prop.key?.type === "Literal") kName = String(prop.key.value);
                if (kName === propKey) return resolveConst(prop.value, depth + 1);
            }
            return null;
        }

        if (node.type === "Identifier") {
            if (stringScope[node.name] !== undefined) return { kind: "string", value: stringScope[node.name] };
            if (objectScope[node.name]) return { kind: "object", node: objectScope[node.name] };
            if (arrayScope[node.name]) return { kind: "array", node: arrayScope[node.name] };
            if (namedFunctions[node.name]) return { kind: "function", node: namedFunctions[node.name] };
            return null;
        }

        return null;
    }

    function resolveFunctionReturnFlat(fnNode, depth) {
        if (!fnNode) return null;
        const body = fnNode.body;
        if (body?.type !== "BlockStatement") return resolveConst(body, depth + 1); // arrow expression body

        // Build a local string scope from declarations inside this function
        // body so IIFE-internal variables resolve correctly (e.g.
        // `const x = "\u002a"; return x;` where x is only local).
        const localSaved = {};
        for (const stmt of (body.body || [])) {
            if (stmt.type !== "VariableDeclaration") continue;
            for (const decl of (stmt.declarations || [])) {
                if (decl.id?.type !== "Identifier" || !decl.init) continue;
                const v = resolveConst(decl.init, depth + 1);
                if (v && v.kind === "string") {
                    localSaved[decl.id.name] = stringScope[decl.id.name]; // save outer
                    stringScope[decl.id.name] = v.value;
                }
            }
        }
        let result = null;
        for (const stmt of (body.body || [])) {
            if (stmt.type === "ReturnStatement" && stmt.argument) {
                result = resolveConst(stmt.argument, depth + 1);
                break;
            }
        }
        // Restore outer scope so local vars don't leak upward
        for (const name of Object.keys(localSaved)) {
            if (localSaved[name] === undefined) delete stringScope[name];
            else stringScope[name] = localSaved[name];
        }
        return result;
    }

    function isIdentityFunctionFlat(node, depth) {
        depth = depth || 0;
        if (!node || depth > 5) return false;
        if (node.type === "Identifier") {
            const fn = namedFunctions[node.name];
            return fn ? isIdentityFunctionFlat(fn, depth + 1) : false;
        }
        if (!FUNCTION_TYPES.has(node.type) || (node.params || []).length !== 1 || node.params[0].type !== "Identifier") return false;
        const paramName = node.params[0].name;
        if (node.type === "ArrowFunctionExpression" && node.body?.type !== "BlockStatement") {
            return node.body?.type === "Identifier" && node.body.name === paramName;
        }
        if (node.body?.type === "BlockStatement" && node.body.body.length === 1 && node.body.body[0].type === "ReturnStatement") {
            const arg = node.body.body[0].argument;
            return arg?.type === "Identifier" && arg.name === paramName;
        }
        return false;
    }

    // True if `node` denotes window.postMessage — directly, via .bind(),
    // via a tracked alias, or laundered through an identity-wrapper call.
    function isPostMessageRefFlat(node, depth) {
        depth = depth || 0;
        if (!node || depth > 10) return false;

        if (node.type === "MemberExpression") {
            if (!node.computed && node.property?.type === "Identifier" && node.property.name === "postMessage") return true;
            if (node.computed) {
                const v = resolveConst(node.property, depth + 1);
                if (v && v.kind === "string" && v.value === "postMessage") return true;
            }
            return false;
        }
        if (node.type === "CallExpression") {
            if (node.callee?.type === "MemberExpression" && node.callee.property?.type === "Identifier" && node.callee.property.name === "bind") {
                return isPostMessageRefFlat(node.callee.object, depth + 1);
            }
            if (isIdentityFunctionFlat(node.callee, depth + 1)) {
                for (const a of (node.arguments || [])) {
                    if (isPostMessageRefFlat(a, depth + 1)) return true;
                }
            }
            return false;
        }
        if (node.type === "Identifier") {
            return node.name === "postMessage" || postMessageAliases.has(node.name);
        }
        return false;
    }

    // Wildcard check given a resolved origin-arg node + how we got there.
    function checkWildcardNode(originArg, line, col, label) {
        if (!originArg) return;
        const resolved = resolveConst(originArg, 0);
        if (resolved && resolved.kind === "string" && resolved.value === "*") {
            addFinding("postMessage(*)", line, col, `Wildcard targetOrigin${label ? " " + label : ""} (resolved to literal '*')`);
            return;
        }
        if (originArg.type === "ConditionalExpression") {
            const c = resolveConst(originArg.consequent, 0);
            const a = resolveConst(originArg.alternate, 0);
            if ((c && c.kind === "string" && c.value === "*") || (a && a.kind === "string" && a.value === "*")) {
                addFinding("postMessage(*)", line, col, `Wildcard targetOrigin${label ? " " + label : ""} (one branch of a conditional resolves to '*')`);
            }
        }
    }

    function walkNode(node, scope) {
        if (!node || typeof node !== "object") return;

        // Track variable declarations (strings/objects/arrays/functions) for
        // resolution later, plus postMessage-alias tracking (GAP-4 and beyond)
        if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
            const resolved = resolveConst(node.init, 0);
            if (resolved) {
                if (resolved.kind === "string") { scope[node.id.name] = resolved.value; stringScope[node.id.name] = resolved.value; }
                else if (resolved.kind === "object") objectScope[node.id.name] = resolved.node;
                else if (resolved.kind === "array") arrayScope[node.id.name] = resolved.node;
                else if (resolved.kind === "function") namedFunctions[node.id.name] = resolved.node;
            }
            if (FUNCTION_TYPES.has(node.init.type)) namedFunctions[node.id.name] = node.init;
            if (node.init.type === "ObjectExpression") {
                objectScope[node.id.name] = node.init;
                for (const prop of (node.init.properties || [])) {
                    if (prop.type === "Property" && prop.key?.type === "Identifier" && FUNCTION_TYPES.has(prop.value?.type)) {
                        objectMethods[`${node.id.name}.${prop.key.name}`] = prop.value;
                    }
                }
            }
            if (node.init.type === "ArrayExpression") arrayScope[node.id.name] = node.init;
            if (isPostMessageRefFlat(node.init)) postMessageAliases.add(node.id.name);
        }

        if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
            namedFunctions[node.id.name] = node;
        }

        if (node.type === "AssignmentExpression") {
            const { left, right } = node;
            const line = node.loc?.start?.line || 0;
            const col  = node.loc?.start?.column || 0;

            if (left?.type === "Identifier" && right) {
                const resolved = resolveConst(right, 0);
                if (resolved) {
                    if (resolved.kind === "string") { scope[left.name] = resolved.value; stringScope[left.name] = resolved.value; }
                    else if (resolved.kind === "object") objectScope[left.name] = resolved.node;
                    else if (resolved.kind === "array") arrayScope[left.name] = resolved.node;
                    else if (resolved.kind === "function") namedFunctions[left.name] = resolved.node;
                }
                if (FUNCTION_TYPES.has(right.type)) namedFunctions[left.name] = right;
                if (isPostMessageRefFlat(right)) postMessageAliases.add(left.name);
            }

            // ANY .onmessage = fn (GAP-2, GAP-3)
            const isOnmessageProp =
                left?.type === "MemberExpression" &&
                left.property?.name === "onmessage";
            const isOnmessageBare = left?.type === "Identifier" && left.name === "onmessage";

            if (isOnmessageProp || isOnmessageBare) {
                if (right && FUNCTION_TYPES.has(right.type)) {
                    analyseHandlerBody(right, addFinding, line, col);
                } else if (right?.type === "Identifier") {
                    deferredHandlers.push({ handlerName: right.name, line, col });
                } else if (right?.type === "MemberExpression" && !right.computed) {
                    const key = `${right.object?.name}.${right.property?.name}`;
                    deferredHandlers.push({ memberKey: key, line, col });
                } else {
                    addFinding("message-listener", line, col, "Handler could not be statically resolved (dynamic expression)");
                }
            }
        }

        if (node.type === "NewExpression") {
            // new Function("a","b","window.postMessage(a,b)") — can't statically
            // parse a runtime string without re-invoking the whole pipeline,
            // so heuristically flag it for manual review.
            if (node.callee?.type === "Identifier" && node.callee.name === "Function") {
                const line = node.loc?.start?.line  || 0;
                const col  = node.loc?.start?.column || 0;
                const bodyArg = node.arguments?.[node.arguments.length - 1];
                const sv = getStringValue(bodyArg);
                if (sv && /postMessage/.test(sv)) {
                    addFinding("postMessage(*)", line, col,
                        "new Function(...) body references postMessage — contents not statically analysed, verify manually");
                }
            }
        }

        if (node.type === "CallExpression") {
            const callee = node.callee;
            const args   = node.arguments || [];
            const line   = node.loc?.start?.line  || 0;
            const col    = node.loc?.start?.column || 0;

            // postMessage wildcard — direct, aliased, .bind()-unwrapped, computed
            // property, or laundered through an identity-wrapper call
            if (isPostMessageRefFlat(callee)) {
                checkWildcardNode(args[1], line, col, null);
            }

            // fnRef.call(thisArg, msg, origin) / fnRef.apply(thisArg, [msg, origin])
            if (callee.type === "MemberExpression" && !callee.computed) {
                const isCall  = callee.property?.type === "Identifier" && callee.property.name === "call";
                const isApply = callee.property?.type === "Identifier" && callee.property.name === "apply";
                if ((isCall || isApply) && isPostMessageRefFlat(callee.object)) {
                    if (isCall && args.length >= 3) {
                        checkWildcardNode(args[2], line, col, "(via .call)");
                    } else if (isApply && args.length >= 2 && args[1].type === "ArrayExpression") {
                        checkWildcardNode(args[1].elements?.[1], line, col, "(via .apply)");
                    }
                }
            }
            // Reflect.apply(fnRef, thisArg, [msg, origin])
            if (
                callee.type === "MemberExpression" && !callee.computed &&
                callee.object?.type === "Identifier" && callee.object.name === "Reflect" &&
                callee.property?.type === "Identifier" && callee.property.name === "apply" &&
                args.length >= 3 && isPostMessageRefFlat(args[0]) && args[2].type === "ArrayExpression"
            ) {
                checkWildcardNode(args[2].elements?.[1], line, col, "(via Reflect.apply)");
            }
            // eval() body mentioning postMessage — heuristic, see new Function above
            if (callee.type === "Identifier" && callee.name === "eval" && args[0]) {
                const sv = getStringValue(args[0]);
                if (sv && /postMessage/.test(sv)) {
                    addFinding("postMessage(*)", line, col,
                        "eval() body references postMessage — contents not statically analysed, verify manually");
                }
            }

            // addEventListener — both .addEventListener and ["addEventListener"] (GAP-1)
            const isAddEL =
                callee.type === "MemberExpression" &&
                (
                    callee.property?.name === "addEventListener" ||
                    (callee.computed && getStringValue(callee.property) === "addEventListener")
                );

            if (isAddEL && args.length >= 2) {
                const eventType = resolveStringVar(args[0]); // GAP-4: resolve variable event types
                if (eventType === "message") {
                    let handler = args[1];

                    // Unwrap .bind()
                    if (
                        handler.type === "CallExpression" &&
                        handler.callee?.type === "MemberExpression" &&
                        handler.callee.property?.name === "bind"
                    ) handler = handler.callee.object;

                    if (FUNCTION_TYPES.has(handler.type)) {
                        analyseHandlerBody(handler, addFinding, line, col);
                    } else if (handler.type === "Identifier") {
                        deferredHandlers.push({ handlerName: handler.name, line, col });
                    } else if (handler.type === "MemberExpression" && !handler.computed) {
                        const key = `${handler.object?.name}.${handler.property?.name}`;
                        deferredHandlers.push({ memberKey: key, line, col });
                    } else if (handler.type === "CallExpression") {
                        // GAP-5: getHandler() — CallExpression result, flag as unresolved
                        addFinding("message-listener", line, col, "Handler is a function call result — could not be statically resolved");
                    } else {
                        addFinding("message-listener", line, col, "Handler could not be statically resolved (dynamic expression)");
                    }
                }
            }
        }

        // Recurse (but don't re-enter function bodies as a new scope — keep flat for simplicity)
        for (const key of Object.keys(node)) {
            if (["type","loc","start","end"].includes(key)) continue;
            const val = node[key];
            if (Array.isArray(val)) val.forEach(c => { if (c && typeof c === "object") walkNode(c, scope); });
            else if (val && typeof val === "object") walkNode(val, scope);
        }
    }

    walkNode(ast, {});

    for (const { handlerName, memberKey, line, col } of deferredHandlers) {
        if (memberKey) {
            const fn = objectMethods[memberKey];
            if (fn) analyseHandlerBody(fn, addFinding, line, col);
            else addFinding("message-listener", line, col, `Handler '${memberKey}' could not be statically resolved`);
        } else {
            const fn = namedFunctions[handlerName];
            if (fn) analyseHandlerBody(fn, addFinding, line, col);
            else addFinding("message-listener", line, col, `Handler '${handlerName}' could not be statically resolved`);
        }
    }
}

// ─── entry point ─────────────────────────────────────────────────────────────

function scanSource(url, source) {
    const findings = [];

    if (url && (
        url.startsWith("chrome-extension://") ||
        url.includes("polyfill") ||
        url.includes("vendor")
    )) return findings;

    console.log("Scanning:", url || "(inline script)");

    const parsed = parseSource(source);
    if (!parsed) {
        console.log("❌ No AST for", url || "inline script");
        return findings;
    }

    const { ast } = parsed;

    if (typeof Babel !== 'undefined' && Babel.packages?.traverse?.default) {
        scanWithBabelTraverse(ast, url, findings);
    } else {
        scanWithAcornWalk(ast, url, findings);
    }

    return findings;
}