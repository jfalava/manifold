import { Effect } from "effect";

import { cliError, fromPromise, type CliEffectError } from "@/effect-kit";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { installRelease } from "@/upgrade/install";
import { assetNameFor, executableNameFor, executablePath } from "@/upgrade/platform";
import { latestCliRelease } from "@/upgrade/release";
import { isNewerVersion } from "@/upgrade/version";

export { checksumFromFile, downloadBytes } from "@/upgrade/install";
export { assetNameFor, executableNameFor, executablePath } from "@/upgrade/platform";
export { extractZipBinary } from "@/upgrade/archive";
export { latestCliRelease } from "@/upgrade/release";
export { isNewerVersion, parseCliVersion } from "@/upgrade/version";

export const upgradeEffect = (currentVersion: string): Effect.Effect<void, CliEffectError> =>
  Effect.gen(function* () {
    openFrame("upgrade");
    const targetPath = yield* Effect.try({
      try: () => executablePath(),
      catch: (cause) => cliError(cause instanceof Error ? cause.message : String(cause)),
    });
    const assetName = yield* Effect.try({
      try: () => assetNameFor(),
      catch: (cause) => cliError(cause instanceof Error ? cause.message : String(cause)),
    });
    const executableName = yield* Effect.try({
      try: () => executableNameFor(),
      catch: (cause) => cliError(cause instanceof Error ? cause.message : String(cause)),
    });
    const release = yield* fromPromise(() => latestCliRelease(assetName, executableName));

    if (!isNewerVersion(release.version, currentVersion)) {
      closeFrame(`manifold ${currentVersion} is already up to date.`);
      return;
    }

    frameDetail(`Updating manifold ${currentVersion} → ${release.version}…`);
    yield* fromPromise(() => installRelease(release, targetPath));
    const suffix = process.platform === "win32" ? " and will be active on the next run" : "";
    closeFrame(`Installed manifold ${release.version}${suffix}.`);
  }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
