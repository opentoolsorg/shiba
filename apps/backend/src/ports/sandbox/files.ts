/** File transport used by the separately authorized offline desktop. */
export interface ContainerFiles {
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Response>;
}

export { createContainerFiles } from "../../adapters/sandbox/cloudflare/files.js";
