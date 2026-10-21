import type { AcpProviderConnection } from "@shiba/shared";

export function providerPhaseLabel(connection: Pick<AcpProviderConnection, "phase" | "testOk">): {
  tone: "ok" | "danger" | "pending" | "navy" | "neutral";
  label: string;
} {
  switch (connection.phase) {
    case "connected":
      if (connection.testOk === true) return { tone: "ok", label: "Ready" };
      if (connection.testOk === false) return { tone: "danger", label: "Test failed" };
      return { tone: "ok", label: "Connected" };
    case "waiting":
      return { tone: "pending", label: "Sign-in pending" };
    case "failed":
      return { tone: "danger", label: "Connection failed" };
    default:
      return { tone: "neutral", label: "Not connected" };
  }
}
