import packageJson from "../package.json" with { type: "json" };

/** Semantic version from cli/package.json (release tags are cli-vX.Y.Z). */
export const CLI_VERSION: string = packageJson.version;
