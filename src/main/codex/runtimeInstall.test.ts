import { describe, expect, it } from "vitest";

import { selectLatestNodeWindowsMsi } from "./runtimeInstall";

describe("selectLatestNodeWindowsMsi", () => {
  it("prefers the newest LTS windows msi build", () => {
    expect(
      selectLatestNodeWindowsMsi([
        { version: "v24.12.0", lts: "Krypton", files: ["win-x64-msi"] },
        { version: "v25.0.0", lts: false, files: ["win-x64-msi"] },
        { version: "v24.14.0", lts: "Krypton", files: ["win-x64-msi", "win-x64-exe"] }
      ])
    ).toEqual({
      version: "24.14.0",
      label: "Node.js LTS 24.14.0",
      fileName: "node-v24.14.0-x64.msi",
      downloadUrl: "https://nodejs.org/dist/v24.14.0/node-v24.14.0-x64.msi"
    });
  });

  it("falls back to the newest non-LTS build when needed", () => {
    expect(
      selectLatestNodeWindowsMsi([
        { version: "v24.14.0", lts: "Krypton", files: ["win-x64-exe"] },
        { version: "v25.8.0", lts: false, files: ["win-x64-msi"] }
      ])
    ).toEqual({
      version: "25.8.0",
      label: "Node.js 25.8.0",
      fileName: "node-v25.8.0-x64.msi",
      downloadUrl: "https://nodejs.org/dist/v25.8.0/node-v25.8.0-x64.msi"
    });
  });

  it("returns null when no windows msi build exists", () => {
    expect(selectLatestNodeWindowsMsi([{ version: "v24.14.0", lts: "Krypton", files: ["linux-x64"] }])).toBeNull();
  });
});
