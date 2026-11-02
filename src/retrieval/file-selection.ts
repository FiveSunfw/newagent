import { privateEntry } from "../exec/snapshot.js";

export interface IndexOptions {
  typescriptOnly?: boolean;
}

/** Shared by offline indexing, runtime refresh and result filtering. */
export function isIndexableFile(file: string, options: IndexOptions = {}) {
  if (file.split(/[\\/]/).some(privateEntry)) return false;
  return options.typescriptOnly
    ? /\.(?:[cm]?ts|tsx)$/i.test(file)
    : /\.(?:[cm]?[jt]sx?|md|py|go|rs|java|json|ya?ml|toml|sql|html|css|sh|c|h|txt)$/i.test(
        file,
      );
}
