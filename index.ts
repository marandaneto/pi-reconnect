import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const statusKey = "network-reconnect";
const internetChecks = [
  "https://www.gstatic.com/generate_204",
  "https://cp.cloudflare.com/generate_204",
];
type Connectivity = "disconnected" | "no-internet" | "online";
type Probe = (signal: AbortSignal) => Promise<Connectivity>;

export function isNetworkFailure(error: string): boolean {
  if (/\b(?:401|402|403|407|429|5\d\d)\b|quota|rate.?limit|unauthori[sz]ed|forbidden|aborted/i.test(error)) return false;
  return /fetch failed|network(?: request)? (?:error|failed)|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b|socket hang up/i.test(error);
}

export function hasNetworkPath(output: string): boolean {
  return /^Network interfaces:[ \t]+\S+/m.test(output);
}

export async function hasInternet(signal: AbortSignal, request = fetch): Promise<boolean> {
  const results = await Promise.all(internetChecks.map(async (url) => {
    try {
      const response = await request(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        redirect: "error",
        cache: "no-store",
      });
      await response.body?.cancel();
      return response.status === 204;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
}

export async function checkConnectivity(signal: AbortSignal): Promise<Connectivity> {
  // scutil reports active macOS network paths, not merely configured interfaces.
  const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--nwi"], {
    signal,
    timeout: 3000,
    maxBuffer: 64 * 1024,
  });
  if (!hasNetworkPath(stdout)) return "disconnected";
  return await hasInternet(signal) ? "online" : "no-internet";
}

export function installReconnect(pi: ExtensionAPI, probe: Probe = checkConnectivity, pollMs = 5000) {
  let enabled = true;
  let pending: AbortController | undefined;

  function cancel(ctx: ExtensionContext) {
    pending?.abort();
    pending = undefined;
    ctx.ui.setStatus(statusKey, undefined);
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!enabled || event.outcome !== "error" || event.continue || ctx.mode !== "tui"
      || ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return;

    const projected = event.context.contextEntries;
    const failedIndex = projected.findLastIndex((entry) => entry.messages.some((m) => m.role === "assistant"));
    const failed = projected[failedIndex];
    const message = failed?.messages.find((m) => m.role === "assistant");
    if (message?.role !== "assistant" || message.stopReason !== "error"
      || !isNetworkFailure(message.errorMessage ?? "")) return;

    const toolCalls = new Set(message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []));
    const targets = [failed.sourceEntry.id, ...projected.slice(failedIndex + 1)
      .filter((entry) => entry.messages.some((m) => m.role === "toolResult" && toolCalls.has(m.toolCallId)))
      .map((entry) => entry.sourceEntry.id)];
    const omissions: SessionBoundaryDraft[] = targets.map((targetId) => ({
      type: "context_edit", targetId, replacement: null,
    }));

    cancel(ctx);
    const controller = new AbortController();
    pending = controller;
    // The low-level run has ended here, so ctx.signal usually cannot cancel this wait.
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) cancel(ctx);
      return undefined;
    });
    let wasOffline = false;
    try {
      while (!controller.signal.aborted) {
        const connectivity = await probe(controller.signal);
        if (controller.signal.aborted || pending !== controller || ctx.hasPendingMessages()) return;
        if (connectivity === "online") {
          if (!wasOffline) return;
          ctx.ui.notify("Internet connection restored — retrying.", "info");
          return { entries: [...event.entries, ...omissions], continue: true };
        }
        wasOffline = true;
        ctx.ui.setStatus(statusKey, connectivity === "disconnected"
          ? "No network connection — waiting to reconnect (Esc to cancel)"
          : "Connected, but no internet — waiting (Esc to cancel)");
        await delay(pollMs, undefined, { signal: controller.signal });
      }
    } catch {
      if (!controller.signal.aborted) {
        ctx.ui.notify("Could not check network connectivity; automatic retry cancelled.", "warning");
      }
    } finally {
      unsubscribe();
      if (pending === controller) cancel(ctx);
    }
  });

  pi.on("input", (_event, ctx) => cancel(ctx));
  pi.on("agent_start", (_event, ctx) => cancel(ctx));
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
  pi.on("session_before_switch", (_event, ctx) => cancel(ctx));
  pi.on("session_before_fork", (_event, ctx) => cancel(ctx));
  pi.on("session_before_tree", (_event, ctx) => cancel(ctx));
  pi.on("model_select", (_event, ctx) => cancel(ctx));

  pi.registerCommand("reconnect", {
    description: "Automatic offline recovery: /reconnect [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "off") {
        enabled = false;
        cancel(ctx);
      } else if (action === "on") {
        enabled = true;
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /reconnect [on|off|status]", "info");
        return;
      }
      ctx.ui.notify(`Offline recovery: ${enabled ? "on" : "off"}${pending ? " (checking/waiting for internet)" : ""}.`, "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  installReconnect(pi);
}
