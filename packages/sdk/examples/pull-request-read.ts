/**
 * Example: read PR status and comments for a thread that already published a PR.
 */
import { Shiba } from "../src/index.js";

const baseUrl = process.env.SHIBA_BASE_URL;
const apiKey = process.env.SHIBA_API_KEY;
const threadId = process.env.SHIBA_THREAD_ID;
if (!baseUrl || !apiKey || !threadId) {
  console.error("Set SHIBA_BASE_URL, SHIBA_API_KEY, and SHIBA_THREAD_ID");
  process.exit(1);
}

const shiba = new Shiba({ baseUrl, apiKey });
console.log(await shiba.pullRequests.status(threadId));
console.log(await shiba.pullRequests.comments(threadId));
console.log(await shiba.pullRequests.review(threadId));
