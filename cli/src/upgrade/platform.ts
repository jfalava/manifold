const ASSETS = {
  "darwin:arm64": {
    archive: "manifold-cli-darwin-arm64.zip",
    executable: "manifold",
  },
  "linux:arm64": {
    archive: "manifold-cli-linux-arm64.zip",
    executable: "manifold",
  },
  "linux:x64": {
    archive: "manifold-cli-linux-x64.zip",
    executable: "manifold",
  },
  "win32:x64": {
    archive: "manifold-cli-windows-x64.zip",
    executable: "manifold.exe",
  },
} as const;

const normalizePath = (path: string): string => path.replaceAll("\\", "/").toLowerCase();

const isCompiledBinaryPath = (normalizedPath: string): boolean =>
  normalizedPath.startsWith("/$bunfs/") || /^[a-z]:\/~bun\/root\//.test(normalizedPath);

const assetNames = (
  platform: string,
  arch: string,
): (typeof ASSETS)[keyof typeof ASSETS] | undefined => {
  const key = `${platform}:${arch}`;
  if (key === "darwin:arm64" || key === "linux:arm64" || key === "linux:x64" || key === "win32:x64") {
    return ASSETS[key];
  }
  return undefined;
};

export const assetNameFor = (platform = process.platform, arch = process.arch): string => {
  const names = assetNames(platform, arch);
  if (!names) {
    throw new Error(`Self-update is not supported on ${platform}/${arch}.`);
  }
  return names.archive;
};

export const executableNameFor = (platform = process.platform, arch = process.arch): string => {
  const names = assetNames(platform, arch);
  if (!names) {
    throw new Error(`Self-update is not supported on ${platform}/${arch}.`);
  }
  return names.executable;
};

export const executablePath = (main = Bun.main, execPath = process.execPath): string => {
  const normalizedMain = normalizePath(main);
  const isCompiledBinary = isCompiledBinaryPath(normalizedMain);
  if (!isCompiledBinary && normalizedMain !== normalizePath(execPath)) {
    throw new Error("upgrade must be run from the compiled manifold binary, not from Bun source.");
  }
  return execPath;
};
