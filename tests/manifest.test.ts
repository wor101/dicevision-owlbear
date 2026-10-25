import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("manifest.json", () => {
  const manifest = JSON.parse(read("public/manifest.json"));

  it("has the fields Owlbear Rodeo documents, within their limits", () => {
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.name.length).toBeLessThanOrEqual(45);
    expect(manifest.description.length).toBeLessThanOrEqual(128);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.action).toMatchObject({ title: "DiceVision", popover: "/action.html" });
    expect(manifest.background_url).toBe("/background.html");
    for (const permission of manifest.permissions) {
      expect(["clipboard-write", "clipboard-read", "autoplay", "bluetooth", "camera", "microphone", "usb", "display-capture", "hid"]).toContain(
        permission.name,
      );
      expect(typeof permission.reason).toBe("string");
    }
  });

  it("points at files that exist", () => {
    for (const path of [manifest.icon, manifest.action.icon]) {
      expect(existsSync(new URL(`public${path}`, root))).toBe(true);
    }
    expect(existsSync(new URL(`.${manifest.action.popover}`, root))).toBe(true);
    expect(existsSync(new URL(`.${manifest.background_url}`, root))).toBe(true);
  });

  it("matches the package version", () => {
    expect(JSON.parse(read("package.json")).version).toBe(manifest.version);
  });
});

describe("store.md", () => {
  it("has the front matter the extension store reads", () => {
    const front = read("public/store.md").split("---")[1];
    for (const key of ["title:", "description:", "author:", "image:", "icon:", "tags:", "manifest:", "learn-more:"]) {
      expect(front).toContain(key);
    }
    expect(front).toContain("- dice");
  });
});
