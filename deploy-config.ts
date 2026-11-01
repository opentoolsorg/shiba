/** Pure preflight: run before declaring any Alchemy resources. */
export function deploymentConfig(
  env: Record<string, string | undefined>,
  { isLiveStage, workerName, liveHost }: { isLiveStage: boolean; workerName: string; liveHost: string },
) {
  if (env.ALCHEMY_STAGE !== undefined && !/^[a-z][a-z0-9-]*$/.test(env.ALCHEMY_STAGE)) {
    throw new Error("ALCHEMY_STAGE must contain lowercase letters, digits and hyphens, starting with a letter");
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/.test(account)) {
    throw new Error("Set an explicit CLOUDFLARE_ACCOUNT_ID (32 lowercase hex characters)");
  }
  if (env.SANDBOX_IMAGE && !env.SANDBOX_IMAGE.startsWith(`registry.cloudflare.com/${account}/`)) {
    throw new Error("SANDBOX_IMAGE must belong to CLOUDFLARE_ACCOUNT_ID in registry.cloudflare.com");
  }
  const subdomain = env.WORKERS_SUBDOMAIN?.trim();
  if (subdomain && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error("WORKERS_SUBDOMAIN must be one lowercase DNS label");
  }
  if (!isLiveStage && !subdomain) throw new Error("Preview stages require WORKERS_SUBDOMAIN");
  const workerHost = isLiveStage ? liveHost : `${workerName}.${subdomain}.workers.dev`;
  if (env.WORKER_HOSTNAME && env.WORKER_HOSTNAME !== workerHost) {
    throw new Error("WORKER_HOSTNAME must match the selected stage's public hostname");
  }
  if (isLiveStage && env.WORKER_HOSTNAME !== liveHost) {
    throw new Error("Live deployment requires explicit WORKER_HOSTNAME matching the checked-in custom domain");
  }
  if (env.BETTER_AUTH_URL && env.BETTER_AUTH_URL !== `https://${workerHost}`) {
    throw new Error("BETTER_AUTH_URL must match the selected stage's HTTPS origin");
  }
  const accessEmails = (env.ACCESS_EMAILS ?? "").split(",").map((email) => email.trim()).filter(Boolean);
  if (accessEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("ACCESS_EMAILS must contain email addresses");
  }
  const accessEnabled = accessEmails.length > 0;
  // Access bindings must come only from the application created for this stage.
  if (env.ACCESS_AUD || (env.REQUIRE_ACCESS && (!accessEnabled || env.REQUIRE_ACCESS !== "1"))) {
    throw new Error("Do not override ACCESS_AUD or REQUIRE_ACCESS; configure managed Access with ACCESS_EMAILS");
  }
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  if (!accessEnabled && (!env.BETTER_AUTH_SECRET ||
    !(env.BETTER_AUTH_BOOTSTRAP_TOKEN?.trim() || env.BETTER_AUTH_OWNER_EMAIL?.trim()))) {
    throw new Error("Public stages require managed Access or BETTER_AUTH_SECRET with a bootstrap token or owner email");
  }
  if (env.BETTER_AUTH_OWNER_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.BETTER_AUTH_OWNER_EMAIL)) {
    throw new Error("BETTER_AUTH_OWNER_EMAIL must be an email address");
  }
  return { workerHost, accessEnabled, accessEmails };
}
