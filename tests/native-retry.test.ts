import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { getModel, createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
const { installReconnect } = await import("../index.ts");

for (const scenario of ["recovered", "provider-still-down", "cancelled"] as const) {
  test(`native Pi lifecycle: ${scenario}`, { timeout: 5000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-network-retry-"));
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      cacheWarming: "off",
    });
    const listeners = new Set<(data: string) => unknown>();
    const errors: unknown[] = [];
    const contexts: any[] = [];
    let probes = 0;
    let waiting!: () => void;
    const offlineStatus = new Promise<void>((resolve) => { waiting = resolve; });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: "Test assistant",
      extensionFactories: [(pi) => {
        installReconnect(pi, async () => {
          probes++;
          assert.equal(contexts.length, probes <= 2 ? 2 : 4, "connectivity check starts only after built-in retries");
          return scenario === "cancelled" || probes === 1 ? "disconnected" : "online";
        }, 1);
      }],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let run: Promise<void> | undefined;
    try {
      await loader.reload();
      const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
      await modelRuntime.setRuntimeApiKey("anthropic", "test-not-a-real-key");
      const result = await createAgentSession({
        cwd: dir, agentDir: dir, model, thinkingLevel: "off", tools: [],
        modelRuntime,
        resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir),
      });
      session = result.session;
      session.sendUserMessage = async () => assert.fail("Native retry must not submit a user message");
      session.agent.streamFunction = (_model, context) => {
        contexts.push(structuredClone(context));
        const success = scenario === "recovered" && contexts.length > 2;
        const message = {
          role: "assistant" as const,
          api: model.api, model: model.id, provider: model.provider,
          content: success ? [{ type: "text" as const, text: "Task completed" }] : [],
          stopReason: success ? "stop" as const : "error" as const,
          ...(success ? {} : { errorMessage: "fetch failed" }),
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream();
        stream.push(success
          ? { type: "done", reason: "stop", message }
          : { type: "error", reason: "error", error: message });
        return stream;
      };
      await session.bindExtensions({
        mode: "tui",
        onError: (error) => errors.push(error),
        uiContext: {
          notify: (message: string, type?: string) => { if (type === "warning") errors.push(message); },
          setStatus: (_key: string, text?: string) => { if (text) waiting(); },
          onTerminalInput: (listener: TerminalInputHandler) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          },
        } as any,
      });
      run = session.prompt("Original task");
      await offlineStatus;
      assert.equal(contexts.length, 2);
      if (scenario === "cancelled") {
        for (const listener of listeners) listener("\x1b");
        await session.abort();
      }
      await run;
      assert.deepEqual(errors, []);
      assert.equal(session.isIdle, true);
      assert.equal(listeners.size, 0);
      assert.equal(contexts.length, scenario === "recovered" ? 3 : scenario === "cancelled" ? 2 : 4);
      assert.equal(probes, scenario === "recovered" ? 2 : scenario === "cancelled" ? 1 : 3);
      for (const context of contexts) {
        const users = context.messages.filter((m: any) => m.role === "user");
        assert.equal(users.length, 1);
        assert.deepEqual(users[0].content, [{ type: "text", text: "Original task" }]);
        assert.equal(context.messages.some((m: any) => m.role === "assistant" && m.stopReason === "error"), false);
      }
      const raw = session.sessionManager.getBranch();
      assert.equal(raw.filter((e: any) => e.type === "message" && e.message.role === "user").length, 1);
      const omissions = raw.filter((e: any) => e.type === "context_edit" && e.replacement === null);
      assert.equal(omissions.length, scenario === "cancelled" ? 1 : scenario === "recovered" ? 2 : 3);
      if (scenario === "recovered") {
        assert.equal(session.getLastAssistantText(), "Task completed");
        assert.equal(session.messages.some((m: any) => m.role === "assistant" && m.stopReason === "error"), false);
        assert.equal(raw.filter((e: any) => e.type === "message" && e.message.stopReason === "error").length, 2,
          "failed attempts remain in raw history");
      }
    } finally {
      for (const listener of listeners) listener("\x1b");
      if (session) {
        await session.abort();
        await run?.catch(() => {});
        session.dispose();
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
