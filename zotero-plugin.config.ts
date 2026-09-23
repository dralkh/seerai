import { defineConfig } from "zotero-plugin-scaffold";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import pkg from "./package.json";
import path from "path";

const ISOGIT_ESM = path.resolve(
  __dirname,
  "node_modules",
  "isomorphic-git",
  "index.js",
);

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/{{version}}/{{xpiName}}.xpi",

  release: {
    bumpp: {
      tag: "%s",
      commit: "chore(publish): release %s",
    },
    hooks: {
      // The scaffold only uploads the XPI. Attach the bundled MCP server, the
      // built manifest, and the update manifest to the versioned release too
      // (best-effort: skipped/failed when the release doesn't exist locally).
      "release:done": (ctx: any) => {
        const tag = String(ctx.release.bumpp.tag).replaceAll(
          "%s",
          String(ctx.version),
        );
        const assets = [
          ".scaffold/build/addon/manifest.json",
          "seerai-mcp.cjs",
          ".scaffold/build/update.json",
        ].filter((file) => existsSync(file));
        if (assets.length === 0) return;
        try {
          execFileSync(
            "gh",
            ["release", "upload", tag, ...assets, "--clobber"],
            { stdio: "inherit" },
          );
        } catch (error) {
          process.stderr.write(
            `[release] Failed to upload extra assets: ${error}\n`,
          );
        }
      },
    },
  },

  build: {
    // seerai-mcp.cjs ships inside the XPI so harnesses can spawn it for the MCP
    // research-tool bridge; it is bundled (mcp-server) before this build runs.
    assets: ["addon/**/*.*", "skills/**/*.*", "seerai-mcp.cjs"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox128",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
        plugins: [
          {
            name: "isomorphic-git-esm",
            setup(build) {
              build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
                path: ISOGIT_ESM,
              }));
            },
          },
        ],
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
