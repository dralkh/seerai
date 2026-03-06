#!/usr/bin/env node
// Bump version in package.json.
// Usage: node scripts/release.js [major|minor|patch|<version>]
import fs from "fs";
import path from "path";

const pkgPath = path.resolve(process.cwd(), "package.json");
const raw = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw);

function normalize(v) {
  return v.startsWith("v") ? v.slice(1) : v;
}

function bumpVersion(current, kind) {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`current version not semver: ${current}`);
  }
  if (kind === "major") {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (kind === "minor") {
    parts[1]++;
    parts[2] = 0;
  } else if (kind === "patch") {
    parts[2]++;
  } else {
    // allow explicit version
    const newv = normalize(kind);
    const newParts = newv.split(".").map(Number);
    if (newParts.length !== 3 || newParts.some(Number.isNaN)) {
      throw new Error(`invalid version: ${kind}`);
    }
    return newv;
  }
  return parts.join(".");
}

async function main() {
  const arg = process.argv[2] || "patch";
  const current = normalize(pkg.version);
  const next = bumpVersion(current, arg);

  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  // print new version to stdout
  console.log(next);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
