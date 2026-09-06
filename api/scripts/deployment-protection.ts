import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeArchive } from "./recovery-archive";
import { verifyRecovery } from "./verify-recovery";

const root = resolve(import.meta.dirname, "../..");

export const assertAlchemyProtection = async (): Promise<void> => {
  for (const provider of ["src/Cloudflare/Workers/WorkerProvider.ts", "lib/Cloudflare/Workers/WorkerProvider.js"]) {
    const source = await readFile(resolve(root, "iac/node_modules/alchemy", provider), "utf8");
    if (!source.includes('name === "manifold-api" && deletedClasses.includes("ManifoldSync")')
      || !source.includes("Refusing to delete manifold-api/ManifoldSync:")) {
      throw new Error("Alchemy deletion protection is missing. Run bun install before planning or deploying.");
    }
  }
};

export const requireDeploymentArchive = async (): Promise<void> => {
  await assertAlchemyProtection();
  // SAFETY: Node and Bun supply this process shape; Workers ambient types
  // otherwise erase the Node process type when IaC imports this module.
  const host = globalThis as { process?: { argv: string[]; env: Record<string, string | undefined> } };
  if (!host.process) {throw new Error("Deployment protection requires Node or Bun");}
  if (!host.process.argv.some((arg) => arg === "deploy" || arg === "destroy")) {return;}
  const archivePath = host.process.env.MANIFOLD_DEPLOY_ARCHIVE;
  if (!archivePath) {
    throw new Error("Deploy/destroy requires a verified offline backup. Use bun run deploy or bun run destroy.");
  }
  const archive = await decodeArchive(await readFile(archivePath));
  const age = Date.now() - archive.backup.createdAt;
  if (age < -60_000 || age > 15 * 60_000) {
    throw new Error("Deployment backup is older than 15 minutes. Run the protected deployment again.");
  }
  await verifyRecovery(archive);
};
