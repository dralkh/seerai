import { CloudProvider } from "./providers/base";
import { GoogleDriveProvider } from "./providers/google";
import { DropboxProvider } from "./providers/dropbox";
import { NextcloudProvider } from "./providers/nextcloud";
import { BoxProvider } from "./providers/box";
import { OneDriveProvider } from "./providers/onedrive";
import { CloudProviderId } from "./types";
import { config } from "../../../package.json";

function pref(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

const PREFS_ACTIVE_PROVIDER = pref("cloud.activeProvider");

export class CloudProviderManager {
  private static instance: CloudProviderManager;

  static getInstance(): CloudProviderManager {
    if (!CloudProviderManager.instance) {
      CloudProviderManager.instance = new CloudProviderManager();
    }
    return CloudProviderManager.instance;
  }

  private providers = new Map<CloudProviderId, CloudProvider>();

  private constructor() {
    this.register(new NextcloudProvider());
    this.register(new GoogleDriveProvider());
    this.register(new OneDriveProvider());
    this.register(new DropboxProvider());
    this.register(new BoxProvider());
  }

  register(provider: CloudProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: CloudProviderId): CloudProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): CloudProvider[] {
    return Array.from(this.providers.values());
  }

  getLoggedIn(): CloudProvider[] {
    return this.getAll().filter((p) => p.isLoggedIn());
  }

  getActive(): CloudProvider {
    const activeId = Zotero.Prefs.get(
      PREFS_ACTIVE_PROVIDER,
    ) as CloudProviderId | null;
    const provider = activeId ? this.providers.get(activeId) : undefined;
    if (provider?.isLoggedIn()) return provider;
    const loggedIn = this.getLoggedIn();
    if (loggedIn.length > 0) return loggedIn[0];
    return this.providers.get("google")!;
  }

  setActive(id: CloudProviderId): void {
    Zotero.Prefs.set(PREFS_ACTIVE_PROVIDER, id);
  }
}
