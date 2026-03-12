export type RuntimeInstallTarget = "nodejs" | "vcRedistX64";

type NodeDistIndexEntry = {
  version: string;
  lts: string | boolean;
  files: string[];
};

export type RuntimeInstallerSpec = {
  label: string;
  version: string | null;
  fileName: string;
  downloadUrl: string;
};

export const VC_REDIST_X64_INSTALLER: RuntimeInstallerSpec = {
  label: "Visual C++ Redistributable (x64)",
  version: null,
  fileName: "vc_redist.x64.exe",
  downloadUrl: "https://aka.ms/vs/17/release/vc_redist.x64.exe"
};

export function selectLatestNodeWindowsMsi(entries: NodeDistIndexEntry[]): RuntimeInstallerSpec | null {
  const windowsMsiEntries = entries.filter((entry) => entry.files.includes("win-x64-msi"));
  if (windowsMsiEntries.length === 0) {
    return null;
  }

  const ltsEntries = windowsMsiEntries.filter((entry) => Boolean(entry.lts));
  const chosen = newestNodeEntry(ltsEntries.length > 0 ? ltsEntries : windowsMsiEntries);
  if (!chosen) {
    return null;
  }

  const versionTag = chosen.version.startsWith("v") ? chosen.version : `v${chosen.version}`;
  const version = versionTag.slice(1);
  const fileName = `node-${versionTag}-x64.msi`;
  return {
    label: Boolean(chosen.lts) ? `Node.js LTS ${version}` : `Node.js ${version}`,
    version,
    fileName,
    downloadUrl: `https://nodejs.org/dist/${versionTag}/${fileName}`
  };
}

function newestNodeEntry(entries: NodeDistIndexEntry[]): NodeDistIndexEntry | null {
  const sorted = [...entries].sort((a, b) => compareNodeVersions(b.version, a.version));
  return sorted[0] ?? null;
}

function compareNodeVersions(a: string, b: string): number {
  const aParts = normalizeNodeVersion(a).split(".").map((part) => Number.parseInt(part, 10));
  const bParts = normalizeNodeVersion(b).split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const delta = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function normalizeNodeVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}
