import { expect, it } from "vitest";
import { deadlinePassed, nativeSessionProof, sessionExpiryMs } from "../src/founder/native-session.js";

const future = () => Date.now() + 60_000;
const session = () => ({ id: "s", userId: "u", expiresAt: future() });

it("refuses a human step whose stored session expiry is unparseable text", () => {
  expect(deadlinePassed(nativeSessionProof(session()).deadline("not a timestamp"))).toBe(true);
  expect(deadlinePassed(future(), sessionExpiryMs("not a timestamp"))).toBe(true);
});

it.each([["NaN", Number.NaN], ["null", null], ["undefined", undefined], ["Infinity", Number.POSITIVE_INFINITY], ["a past time", 1]])("treats %s among the candidates as passed", (_name, bad) => {
  expect(deadlinePassed(future(), bad, future())).toBe(true);
});

it("has passed when there is nothing to prove a deadline with, and has not while every candidate is ahead", () => {
  expect(deadlinePassed()).toBe(true);
  expect(deadlinePassed(future(), future())).toBe(false);
  expect(deadlinePassed(nativeSessionProof(session()).deadline(future()))).toBe(false);
  expect(deadlinePassed(nativeSessionProof(session()).deadline(new Date(future()).toISOString()))).toBe(false);
});
