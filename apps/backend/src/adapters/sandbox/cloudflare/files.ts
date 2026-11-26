/* eslint-disable no-restricted-imports -- These adapters import backend-internal modules, three directories below src/. */
import { Files } from "@cloudflare/sandbox";
import type { ContainerFiles } from "../../../ports/sandbox/files.js";

export function createContainerFiles(container: Container): ContainerFiles {
  return new Files(container);
}
