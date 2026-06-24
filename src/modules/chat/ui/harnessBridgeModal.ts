import {
  connectHarness,
  disconnectHarness,
  isHarnessConnected,
} from "../cli/mcpBridge";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// Harnesses whose tools reach seerai's library ONLY via a persistent MCP config
// (Claude/Codex attach automatically per session, so they need no modal).
const PERSISTENT_HARNESSES = new Set(["hermes", "antigravity", "openclaw"]);

/**
 * Offer to connect seerai's research-tool bridge for a freshly-connected CLI
 * harness. No-op for harnesses that attach automatically (Claude/Codex) or that
 * aren't CLI harnesses. Optional/dismissable — replaces the separate settings
 * section so the prompt is contextual to connecting the harness.
 */
export function offerHarnessBridge(
  doc: Document,
  agentId: string | undefined,
  agentName: string,
): void {
  if (!agentId || !PERSISTENT_HARNESSES.has(agentId)) return;
  showHarnessBridgeModal(doc, agentId, agentName);
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  css?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (css) node.style.cssText = css;
  return node;
}

function showHarnessBridgeModal(
  doc: Document,
  agentId: string,
  agentName: string,
): void {
  const overlay = el(
    doc,
    "div",
    "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.45);",
  );

  const card = el(
    doc,
    "div",
    "max-width:440px;width:calc(100% - 48px);background:var(--material-background,#fff);" +
      "color:var(--fill-primary,#111);border-radius:12px;padding:20px 22px;" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.3);font-size:13px;line-height:1.5;",
  );

  const title = el(
    doc,
    "div",
    "font-size:15px;font-weight:600;margin-bottom:8px;",
  );
  title.textContent = `Give ${agentName} your Zotero tools?`;

  const body = el(
    doc,
    "div",
    "color:var(--fill-secondary,#444);margin-bottom:14px;",
  );
  body.textContent =
    `seerai can let ${agentName} search your library, read papers, manage ` +
    `notes/collections/tables, and run systematic reviews — directly, via a local ` +
    `MCP bridge. This adds one entry to the harness's config and is reversible.`;

  const status = el(
    doc,
    "div",
    "min-height:18px;margin-bottom:12px;font-size:12px;color:var(--fill-secondary,#666);",
  );

  const actions = el(
    doc,
    "div",
    "display:flex;gap:8px;justify-content:flex-end;align-items:center;",
  );

  const btnCss = (primary: boolean) =>
    "padding:7px 14px;border-radius:8px;border:1px solid var(--fill-quinary,#ccc);" +
    "cursor:pointer;font-size:13px;" +
    (primary
      ? "background:var(--color-accent,#2563eb);color:#fff;border-color:transparent;"
      : "background:transparent;color:inherit;");

  const secondary = el(doc, "button", btnCss(false));
  const primary = el(doc, "button", btnCss(true));

  const dismiss = () => overlay.remove();

  const render = () => {
    const connected = isHarnessConnected(agentId);
    secondary.textContent = connected ? "Close" : "Not now";
    primary.textContent = connected ? "Disconnect" : "Connect";
    primary.style.cssText = btnCss(!connected);
  };

  const run = async () => {
    const connected = isHarnessConnected(agentId);
    primary.disabled = true;
    secondary.disabled = true;
    status.textContent = connected ? "Disconnecting…" : "Connecting…";
    const res = connected
      ? await disconnectHarness(agentId)
      : await connectHarness(agentId);
    status.textContent = res.message;
    status.style.color = res.ok
      ? "var(--fill-secondary,#666)"
      : "var(--color-error,#c0392b)";
    primary.disabled = false;
    secondary.disabled = false;
    render();
  };

  primary.addEventListener("click", () => void run());
  secondary.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });

  actions.append(secondary, primary);
  card.append(title, body, status, actions);
  overlay.appendChild(card);
  (doc.body || doc.documentElement)?.appendChild(overlay);
  render();
}
