import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { assertAlchemyProtection } from "./deployment-protection";
import { createRecoveryArchive, repositoryRoot } from "./registry-recovery";
import { decodeArchive } from "./recovery-archive";
import { verifyRecovery } from "./verify-recovery";

const [command, ...args] = process.argv.slice(2);
try {
  if (command !== "deploy" && command !== "destroy") {throw new Error("Expected deploy or destroy");}
  await assertAlchemyProtection();
  const archiveIndex = args.indexOf("--archive");
  const suppliedArchive = archiveIndex >= 0 ? args[archiveIndex + 1] : undefined;
  if (archiveIndex >= 0 && !suppliedArchive) {throw new Error("--archive requires a verified recovery archive path");}
  const archive = suppliedArchive ? resolve(repositoryRoot, suppliedArchive) : await createRecoveryArchive();
  if (suppliedArchive) {await verifyRecovery(await decodeArchive(await readFile(archive)));}
  const forwarded = args.filter((arg, index) => arg !== "--" && (archiveIndex < 0 || (index !== archiveIndex && index !== archiveIndex + 1)));
  const child = Bun.spawn([
    "bun", resolve(repositoryRoot, "iac/node_modules/alchemy/bin/alchemy.ts"),
    command, ...forwarded,
  ], {
    cwd: resolve(repositoryRoot, "iac"),
    env: { ...process.env, MANIFOLD_DEPLOY_ARCHIVE: archive },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Protected deployment failed");
  process.exitCode = 1;
}
