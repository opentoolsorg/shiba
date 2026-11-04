import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = pathToFileURL(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/run-employee-ci.mjs")).href;

function check(source: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import assert from 'node:assert/strict'; import {createFixtureAuth,fixtureAuthRequest,fixtureChildEnv,fixtureWorkerVars} from ${JSON.stringify(fixture)}; ${source}`],
  { env: {}, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
  expect(result.status).toBe(0);
}

describe("isolated employee fixture bootstrap", () => {
  it("mints a fresh setup token and binds it to the Worker and exact signup header without putting it in the body", () => {
    check(`
      const first=createFixtureAuth(),second=createFixtureAuth();
      assert(/^[a-f0-9]{64}$/.test(first.bootstrapToken));
      assert(first.bootstrapToken!==second.bootstrapToken,'Setup tokens must be fresh per fixture.');
      const vars=fixtureWorkerVars('http://localhost:8794',first,{pairing:'fixture-pair',auth:'fixture-auth',signing:'fixture-signing'});
      const request=fixtureAuthRequest(first);
      assert.equal(request.route,'/api/auth/sign-up/email');
      assert(request.headers['x-shiba-bootstrap-token']===vars.BETTER_AUTH_BOOTSTRAP_TOKEN);
      assert(vars.BETTER_AUTH_OWNER_EMAIL===request.body.email);
      assert.deepEqual(Object.keys(request.body).sort(),['email','name','password']);
      assert(!JSON.stringify(request.body).includes(first.bootstrapToken),'Setup token must not enter the auth JSON body.');
      assert.equal(vars.MEMORY_ENABLED,'0');assert.equal(vars.TYPESAFE_API_KEY,'');
    `);
  });

  it("does not resend a setup token on sign-in or copy saved fixture metadata into authentication bodies", () => {
    check(`
      const account={...createFixtureAuth(),created:true,extra:'private fixture metadata'};
      const request=fixtureAuthRequest(account);
      assert.equal(request.route,'/api/auth/sign-in/email');
      assert.deepEqual(request.headers,{});
      assert.deepEqual(Object.keys(request.body).sort(),['email','password']);
    `);
  });

  it("preserves tokenless local-driver signup without weakening server bootstrap checks", () => {
    check(`
      const request=fixtureAuthRequest({name:'Fixture',email:'fixture@example.test',password:'fixture-password'});
      assert.equal(request.route,'/api/auth/sign-up/email');assert.deepEqual(request.headers,{});
      assert.deepEqual(Object.keys(request.body).sort(),['email','name','password']);
    `);
  });

  it("never forwards operator bootstrap or provider credentials into the fixture child environment", () => {
    check(`
      const env=fixtureChildEnv({PATH:'/fixture/bin',BETTER_AUTH_BOOTSTRAP_TOKEN:'operator-setup',INTERNAL_SIGNING_KEY:'operator-signing',AI_GATEWAY_TOKEN:'operator-model',TYPESAFE_API_KEY:'operator-typesafe'},'/fixture/private');
      for(const name of ['BETTER_AUTH_BOOTSTRAP_TOKEN','INTERNAL_SIGNING_KEY','AI_GATEWAY_TOKEN','TYPESAFE_API_KEY'])assert(!Object.hasOwn(env,name),'Operator credentials must not be inherited.');
      assert.equal(env.PATH,'/fixture/bin');assert.equal(env.HOME,'/fixture/private/home');
    `);
  });
});
