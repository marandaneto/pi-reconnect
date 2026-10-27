import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";

const { hasInternet, hasNetworkPath, installReconnect, isNetworkFailure } = await import("../index.ts");

type Connectivity = "disconnected" | "no-internet" | "online";
function harness(probe: (signal: AbortSignal) => Promise<Connectivity>) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const terminalListeners = new Set<Function>();
  const statuses: (string | undefined)[] = [];
  let queued = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => false,
    hasPendingMessages: () => queued,
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: () => {},
      onTerminalInput: (listener: Function) => {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
    },
  };
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: () => assert.fail("Recovery must not send a user message"),
    sendMessage: () => assert.fail("Recovery must not send a custom message"),
  };
  installReconnect(pi as any, probe, 1);
  const emit = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  const user = { sourceEntry: { id: "user" }, messages: [{ role: "user", content: "Original task" }] };
  const failure = (errorMessage = "fetch failed", stopReason = "error") => ({
    entries: [], continue: false, outcome: "error",
    context: {
      contextEntries: [user, {
        sourceEntry: { id: "failed" },
        messages: [{ role: "assistant", stopReason, errorMessage, content: [] }],
      }],
      pendingMessages: [], canContinue: false,
    },
  });
  return {
    emit, failure, statuses, ctx, terminalListeners,
    fail: (error?: string, stopReason?: string) => emit("agent_before_settle", failure(error, stopReason)),
    command: (arg: string) => commands.get("reconnect").handler(arg, ctx),
    key: (data: string) => { for (const listener of terminalListeners) listener(data); },
    queue: () => { queued = true; },
    close: () => emit("session_shutdown"),
  };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for recovery");
}

const expectedRetry = {
  continue: true,
  entries: [{ type: "context_edit", targetId: "failed", replacement: null }],
};

test("recognizes transport failures, not HTTP/provider/auth errors", () => {
  for (const error of ["fetch failed", "getaddrinfo ENOTFOUND api.test", "EAI_AGAIN", "connect ENETUNREACH", "socket hang up", "ECONNRESET", "ETIMEDOUT"]) {
    assert.equal(isNetworkFailure(error), true, error);
  }
  for (const error of ["401 Unauthorized", "429 rate limited", "503 Service Unavailable", "quota exceeded", "context too long", "aborted", "HTTP 502: fetch failed", "401: fetch failed"]) {
    assert.equal(isNetworkFailure(error), false, error);
  }
});

test("distinguishes no active macOS network path from Wi-Fi/Ethernet", () => {
  assert.equal(hasNetworkPath("No network information available"), false);
  assert.equal(hasNetworkPath("Network interfaces: en0\n"), true);
  assert.equal(hasNetworkPath("Network interfaces: en1 en0\n"), true);
  assert.equal(hasNetworkPath("Network interfaces: \n"), false);
});

test("one working independent internet endpoint is sufficient", async () => {
  const urls: string[] = [];
  const request = async (url: string, options: RequestInit) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    return new Response(null, { status: url.includes("gstatic") ? 503 : 204 });
  };
  assert.equal(await hasInternet(new AbortController().signal, request as any), true);
  assert.equal(urls.length, 2);
});

test("captive portal responses and failed probes are not internet access", async () => {
  const request = async (url: string) => {
    if (url.includes("gstatic")) throw new TypeError("fetch failed");
    return new Response("Sign in to Wi-Fi", { status: 200 });
  };
  assert.equal(await hasInternet(new AbortController().signal, request as any), false);
});

test("provider failure with working internet never starts recovery", async () => {
  let probes = 0;
  const h = harness(async () => { probes++; return "online"; });
  try {
    assert.equal(await h.fail(), undefined);
    assert.equal(probes, 1);
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(h.terminalListeners.size, 0);
  } finally { await h.close(); }
});

for (const state of ["disconnected", "no-internet"] as const) {
  test(`${state}: retries natively once, without sending any message`, async () => {
    let online = false;
    const h = harness(async () => online ? "online" : state);
    const recovery = h.fail();
    try {
      await until(() => h.statuses.some((s) => s?.includes(state === "disconnected" ? "No network connection" : "Connected, but no internet")));
      online = true;
      assert.deepEqual(await recovery, expectedRetry);
      assert.equal(h.statuses.at(-1), undefined);
      assert.equal(h.terminalListeners.size, 0);
      assert.equal(await h.fail(), undefined, "provider still down while online must not loop");
    } finally { await h.close(); await recovery; }
  });
}

test("does not probe before Pi's built-in retries finish", async () => {
  let probes = 0;
  const h = harness(async () => { probes++; return "disconnected"; });
  try {
    await h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed" } });
    await h.emit("agent_end");
    assert.equal(probes, 0);
    const event = h.failure();
    event.outcome = "completed";
    await h.emit("agent_before_settle", event);
    assert.equal(probes, 0);
  } finally { await h.close(); }
});

test("HTTP errors, user cancellation, and headless mode never recover", async () => {
  let probes = 0;
  const h = harness(async () => { probes++; return "disconnected"; });
  try {
    await h.fail("503 Service Unavailable");
    await h.fail("fetch failed", "aborted");
    const event = h.failure();
    event.outcome = "aborted";
    await h.emit("agent_before_settle", event);
    h.ctx.mode = "print";
    await h.fail();
    assert.equal(probes, 0);
  } finally { await h.close(); }
});

for (const event of ["input", "agent_start", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "model_select"]) {
  test(`${event} cancels an in-flight connectivity check`, async () => {
    let resolve!: (state: Connectivity) => void;
    let signal!: AbortSignal;
    let probes = 0;
    const h = harness((s) => {
      if (++probes === 1) return Promise.resolve("disconnected");
      signal = s;
      return new Promise((r) => { resolve = r; });
    });
    const recovery = h.fail();
    try {
      await until(() => probes === 2);
      await h.emit(event);
      assert.equal(signal.aborted, true);
      resolve("online");
      assert.equal(await recovery, undefined);
      assert.equal(h.statuses.at(-1), undefined);
      assert.equal(h.terminalListeners.size, 0);
    } finally { await h.close(); }
  });
}

for (const key of ["\x1b", "\x03", "\x1b[27u", "\x1b[99;5u"]) {
  test(`interrupt ${JSON.stringify(key)} cancels waiting without a model request`, async () => {
    const h = harness(async () => "disconnected");
    const recovery = h.fail();
    try {
      await until(() => h.statuses.some(Boolean));
      h.key(key);
      assert.equal(await recovery, undefined);
      assert.equal(h.terminalListeners.size, 0);
    } finally { await h.close(); await recovery; }
  });
}

test("off cancels waiting; on permits a later offline recovery", async () => {
  let online = false;
  const h = harness(async () => online ? "online" : "disconnected");
  const recovery = h.fail();
  try {
    await until(() => h.statuses.some(Boolean));
    await h.command("off");
    assert.equal(await recovery, undefined);
    assert.equal(await h.fail(), undefined);
    await h.command("on");
    const retry = h.fail();
    await nextTick();
    online = true;
    assert.deepEqual(await retry, expectedRetry);
  } finally { await h.close(); await recovery; }
});

test("queued work prevents a stale continuation", async () => {
  let online = false;
  const h = harness(async () => online ? "online" : "disconnected");
  const recovery = h.fail();
  try {
    await until(() => h.statuses.some(Boolean));
    h.queue();
    online = true;
    assert.equal(await recovery, undefined);
  } finally { await h.close(); await recovery; }
});

test("an existing continuation or pending context does not start recovery", async () => {
  let probes = 0;
  const h = harness(async () => { probes++; return "disconnected"; });
  try {
    const event = h.failure();
    event.continue = true;
    await h.emit("agent_before_settle", event);
    event.continue = false;
    (event.context.pendingMessages as any[]).push({ role: "user", content: "New task" });
    await h.emit("agent_before_settle", event);
    assert.equal(probes, 0);
  } finally { await h.close(); }
});

test("omits failed attempt and paired tool results, preserving prior drafts and successful work", async () => {
  let probes = 0;
  const h = harness(async () => ++probes === 1 ? "no-internet" : "online");
  try {
    const event = h.failure();
    const [user, failed] = event.context.contextEntries;
    (failed.messages[0].content as any[]).push({ type: "toolCall", id: "bad-call", name: "bash" });
    const successful = { sourceEntry: { id: "previous-tool" }, messages: [{ role: "toolResult", toolCallId: "good-call" }] };
    const paired = { sourceEntry: { id: "paired-tool" }, messages: [{ role: "toolResult", toolCallId: "bad-call" }] };
    (event.context.contextEntries as any[]) = [user, successful, failed, paired];
    const existing = { type: "custom", customType: "another-extension" };
    (event.entries as any[]).push(existing);
    assert.deepEqual(await h.emit("agent_before_settle", event), {
      continue: true,
      entries: [existing, expectedRetry.entries[0], { type: "context_edit", targetId: "paired-tool", replacement: null }],
    });
  } finally { await h.close(); }
});

test("failed network detection stops safely instead of assuming offline", async () => {
  const h = harness(async () => { throw new Error("scutil failed"); });
  try {
    assert.equal(await h.fail(), undefined);
    assert.equal(h.statuses.at(-1), undefined);
    assert.equal(h.terminalListeners.size, 0);
  } finally { await h.close(); }
});
