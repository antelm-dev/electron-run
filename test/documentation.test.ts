import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), "utf8")) as T;
}

describe("documentation metadata", () => {
  it("documents every public package entry point", () => {
    const packageJson = readJson<{
      exports: Record<string, { types: string }>;
    }>("package.json");
    const typedoc = readJson<{ entryPoints: string[] }>("typedoc.json");

    const publishedEntryPoints = Object.values(packageJson.exports).map(({ types }) =>
      types.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$/, ".ts"),
    );

    expect(new Set(typedoc.entryPoints)).toEqual(new Set(publishedEntryPoints));
  });

  it("uses absolute license links that remain valid on the generated docs site", () => {
    const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
    const licenseLinks = [...readme.matchAll(/\[[^\]]*\]\(([^)]*LICENSE)\)/g)].map(
      ([, target]) => target,
    );

    expect(licenseLinks.length).toBeGreaterThan(0);
    expect(licenseLinks).toEqual(
      expect.arrayContaining(["https://github.com/antelm-dev/electron-run/blob/master/LICENSE"]),
    );
    expect(licenseLinks.every((target) => target?.startsWith("https://"))).toBe(true);
  });
});
