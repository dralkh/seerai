import { CloudProvider } from "./providers/base";
import { extractCodeFromUrl } from "./pkce";

function extractErrorFromUrl(url: string): string | null {
  if (!url.includes("?")) return null;
  const qs = url.split("?")[1] || "";
  const params = new URLSearchParams(qs);
  return params.get("error");
}

export function registerCallbackEndpoint(
  path: string,
  provider: CloudProvider,
): void {
  Zotero.Server.Endpoints[path] = function () {
    return {
      supportedMethods: ["GET"],
      supportedDataTypes: ["text/html"],
      permitBookmarklet: false,
      init: async function (requestData: any) {
        try {
          const url = requestData?.url || "";
          const error = extractErrorFromUrl(url);
          if (error) {
            let hint = "";
            const errDetail =
              new URLSearchParams(url.split("?")[1] || "").get(
                "error_detail",
              ) || "";
            if (error === "invalid_redirect_uri") {
              hint = `<p style="font-size:14px;margin-top:12px;">The redirect URI <code>${provider.getRedirectUri()}</code> is not registered in your ${provider.name} app console.</p><p style="font-size:13px;">Go to your app settings, add this exact URI under "Redirect URIs", and click Save.</p>`;
            } else if (errDetail) {
              hint = `<p style="font-size:13px;margin-top:12px;">${errDetail}</p>`;
            }
            return [
              400,
              "text/html",
              `<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h1>Auth Failed</h1><p>${provider.name} returned: ${error}</p>${hint}<p style="margin-top:20px;font-size:12px;color:#888;">You can close this tab and paste the authorization code manually in Zotero.</p></body></html>`,
            ];
          }
          const code = extractCodeFromUrl(url);
          if (!code) {
            return [
              400,
              "text/html",
              `<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h1>No Auth Code</h1><p>No authorization code received from ${provider.name}.</p><p style="font-size:13px;color:#666;">If you see an authorization code on the ${provider.name} page, copy it and paste it in Zotero's connection dialog.</p></body></html>`,
            ];
          }
          await provider.handleCallback(code);
          return [
            200,
            "text/html",
            `<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#f0fff4;"><h1 style="color:#188038;">Connected!</h1><p>You are now connected to ${provider.name}. You can close this tab.</p></body></html>`,
          ];
        } catch (e: any) {
          return [
            500,
            "text/html",
            `<html><body style="font-family:sans-serif;padding:40px;text-align:center;"><h1>Error</h1><p>${e?.message || String(e)}</p><p style="font-size:12px;color:#888;margin-top:20px;">Try pasting the authorization code manually in Zotero instead.</p></body></html>`,
          ];
        }
      },
    };
  };
  Zotero.debug(
    `[seerai] Registered OAuth callback at ${path} for ${provider.name}`,
  );
}
