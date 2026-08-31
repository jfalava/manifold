import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import RealmModule from "realm";

const Realm = RealmModule.Realm;
const args = process.argv.slice(2);
const details = args.includes("--details");
const fileArg = args.find((arg) => !arg.startsWith("--")) ?? "default.realm";
const filePath = resolve(fileArg);

if (!existsSync(filePath)) {
  console.error(`Realm file not found: ${filePath}`);
  process.exitCode = 1;
} else {
  const realm = new Realm({
    path: filePath,
    readOnly: true,
    disableFormatUpgrade: true,
  });

  try {
    const objectTypes = realm.schema.map(({ name }) => name).sort();
    const counts = Object.fromEntries(
      objectTypes.map((name) => {
        try {
          return [name, realm.objects(name).length];
        } catch {
          return [name, null];
        }
      }),
    );

    const sourceStates = Array.from(realm.objects("SourceStateObject"));
    const sourceIds = [...new Set(sourceStates.map(({ sourceId }) => sourceId))].sort();

    const output = {
      file: filePath,
      bytes: statSync(filePath).size,
      schemaVersion: Realm.schemaVersion(filePath),
      objectTypes,
      counts,
      sourceStateCount: sourceStates.length,
      sourceIds,
      note: "SourceStateObject.value is intentionally not printed because it may contain credentials or session data.",
    };

    if (details) {
      output.sourceRepositories = Array.from(
        realm.objects("SourceRepositoryObject"),
        ({ name, url }) => ({ name, url: redactUrl(url) }),
      );
      output.sourceManga = Array.from(realm.objects("SourceMangaObject"), ({ sourceId, mangaId, mangaInfo }) => ({
        sourceId,
        mangaId,
        title: mangaInfo?.primaryTitle ?? null,
      }));
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    realm.close();
    Realm.shutdown();
  }
}

function redactUrl(value) {
  if (typeof value !== "string") return value;

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<redacted non-URL value>";
  }
}
