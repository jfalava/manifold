/**
 * Write src/lib/licenses.ts: every direct dependency declared by the
 * repository's workspaces, at its installed version, with its declared license,
 * a short excerpt of its license file, and a link to the full text.
 *
 *   bun scripts/generate-licenses.ts           # regenerate
 *   bun scripts/generate-licenses.ts --check   # fail when the file is stale
 *
 * Optional dependencies are skipped: they are per-platform binaries
 * (e.g. @bruits/satteri-*) and only one of them is ever installed.
 */
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, isString, objectField, stringField, type JsonObject } from "@manifold/json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destination = join(root, "docs/src/lib/licenses.ts");
const licenseFilePattern = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const fallbackLicenseFiles = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"];

interface PackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly excerpt: string;
}

async function readPackageJson(path: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));

  if (!isJsonObject(value)) {
    throw new Error(`${path} is not a JSON object.`);
  }

  return value;
}

async function workspaceDirectories(): Promise<string[]> {
  const manifest = await readPackageJson(join(root, "package.json"));
  const patterns = objectField(manifest, "workspaces")?.packages;

  if (!Array.isArray(patterns)) {
    throw new Error("package.json workspaces.packages is missing.");
  }

  const directories = [root];

  for (const pattern of patterns.filter(isString)) {
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      const entries = await readdir(parent, { withFileTypes: true });

      directories.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name)));
    } else {
      directories.push(join(root, pattern));
    }
  }

  return directories;
}

/** Resolve through the workspace's node_modules symlink, then the root one. */
async function packageDirectory(name: string, workspace: string): Promise<string> {
  for (const base of [workspace, root]) {
    try {
      return dirname(await realpath(join(base, "node_modules", name, "package.json")));
    } catch {
      // Not linked from this node_modules; try the next one.
    }
  }

  throw new Error(`${name} (declared by ${workspace}) is not installed. Run bun install first.`);
}

function repositoryUrl(pkg: JsonObject): { readonly url: string; readonly directory?: string } {
  const repository = pkg.repository;
  const source = isString(repository)
    ? repository
    : isJsonObject(repository)
      ? stringField(repository, "url")
      : undefined;
  const url = (source ?? stringField(pkg, "homepage") ?? "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "")
    .replace(/\/$/, "");
  const directory = isJsonObject(repository)
    ? stringField(repository, "directory")?.replace(/^\//, "")
    : undefined;

  return directory === undefined ? { url } : { url, directory };
}

/** Prefer a GitHub blob link; fall back to the published file on unpkg. */
async function licenseUrl(pkg: PackageLicense, repo: ReturnType<typeof repositoryUrl>, file: string | undefined) {
  const unpkg = `https://unpkg.com/${pkg.name}@${pkg.version}/${file ?? "package.json"}`;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repo.url);

  if (match === null) {
    return unpkg;
  }

  const files = [...new Set([...(file === undefined ? [] : [file]), ...fallbackLicenseFiles])];
  const paths = [
    ...new Set([
      ...(repo.directory === undefined ? [] : files.map((name) => `${repo.directory}/${name}`)),
      ...files,
    ]),
  ];

  for (const branch of ["main", "master"]) {
    const found = await Promise.all(
      paths.map(async (path) => {
        try {
          const response = await fetch(
            `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/${path}`,
            { method: "HEAD", signal: AbortSignal.timeout(5000) },
          );

          return response.ok ? path : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const path = found.find((candidate) => candidate !== undefined);

    if (path !== undefined) {
      return `${repo.url}/blob/${branch}/${path}`;
    }
  }

  return unpkg;
}

async function describe(directory: string): Promise<PackageLicense> {
  const pkg = await readPackageJson(join(directory, "package.json"));
  const name = stringField(pkg, "name");
  const version = stringField(pkg, "version");
  const licenseField = pkg.license;
  const license = isString(licenseField)
    ? licenseField
    : isJsonObject(licenseField)
      ? stringField(licenseField, "type")
      : undefined;

  if (name === undefined || version === undefined) {
    throw new Error(`${directory}/package.json has no name or version.`);
  }

  if (license === undefined) {
    throw new Error(`${name}@${version} declares no license; review it before publishing.`);
  }

  const file = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()[0];
  const excerpt =
    file === undefined
      ? ""
      : (await readFile(join(directory, file), "utf8"))
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, 5)
          .join("\n");
  const entry = { name, version, license, licenseUrl: "", excerpt };

  return { ...entry, licenseUrl: await licenseUrl(entry, repositoryUrl(pkg), file) };
}

// Map the real installed directory to its package; npm aliases such as
// `satteri-source-parser` (npm:satteri) collapse onto the package they alias.
const directories = new Set<string>();

for (const workspace of await workspaceDirectories()) {
  const manifest = await readPackageJson(join(workspace, "package.json"));

  for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(objectField(manifest, group) ?? {})) {
      if (!name.startsWith("@manifold/") && !name.startsWith("@types/")) {
        directories.add(await packageDirectory(name, workspace));
      }
    }
  }
}

const described = await Promise.all([...directories].map(describe));
const packages = [...new Map(described.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values()].toSorted(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const output = `// Generated by bun run licenses; do not edit.\nexport const packages = ${JSON.stringify(packages, null, 2)} as const;\n`;

if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== output) {
    throw new Error("docs/src/lib/licenses.ts is stale. Run bun run --cwd docs licenses.");
  }
} else {
  await writeFile(destination, output);
}
