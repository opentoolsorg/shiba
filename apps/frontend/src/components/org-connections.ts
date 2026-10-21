// Hook and types for managing org runner and model-key connections during onboarding.
import { useCallback, useState } from "react";

export type RunnerBackend = "e2b" | "modal" | "daytona";
export type ModelProvider = "anthropic" | "openai" | "google" | "xai";

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface SaveSandboxResponse {
  ok: boolean;
  error?: string;
  settings?: {
    runnerUrl?: string;
    runnerTokenMeta?: { configured: boolean; last4?: string };
  };
}

export interface SaveModelResponse {
  ok: boolean;
  error?: string;
  key?: { configured: boolean; last4?: string };
}

export interface UseOrgConnectionsResult {
  // Sandbox connection state
  runnerUrl: string;
  setRunnerUrl: (val: string) => void;
  runnerToken: string;
  setRunnerToken: (val: string) => void;
  runnerBackend: RunnerBackend;
  setRunnerBackend: (val: RunnerBackend) => void;
  sandboxConfigured: boolean;
  sandboxLast4: string | null;
  testingSandbox: boolean;
  savingSandbox: boolean;
  sandboxTestResult: TestResult | null;
  sandboxSaveError: string | null;
  canSaveSandbox: boolean;
  testSandbox: () => Promise<TestResult>;
  saveSandbox: () => Promise<SaveSandboxResponse>;

  // Model key connection state
  modelProvider: ModelProvider;
  setModelProvider: (val: ModelProvider) => void;
  modelApiKey: string;
  setModelApiKey: (val: string) => void;
  modelConfigured: boolean;
  modelLast4: string | null;
  testingModel: boolean;
  savingModel: boolean;
  modelTestResult: TestResult | null;
  modelSaveError: string | null;
  canSaveModel: boolean;
  testModel: () => Promise<TestResult>;
  saveModel: () => Promise<SaveModelResponse>;
}

export function useOrgConnections(): UseOrgConnectionsResult {
  // Sandbox state
  const [runnerUrl, setRunnerUrl] = useState("");
  const [runnerToken, setRunnerToken] = useState("");
  const [runnerBackend, setRunnerBackend] = useState<RunnerBackend>("e2b");
  const [sandboxConfigured, setSandboxConfigured] = useState(false);
  const [sandboxLast4, setSandboxLast4] = useState<string | null>(null);
  const [testingSandbox, setTestingSandbox] = useState(false);
  const [savingSandbox, setSavingSandbox] = useState(false);
  const [sandboxTestResult, setSandboxTestResult] = useState<TestResult | null>(null);
  const [sandboxSaveError, setSandboxSaveError] = useState<string | null>(null);
  const [sandboxTestedCandidate, setSandboxTestedCandidate] = useState<{
    url: string;
    token: string;
  } | null>(null);

  // Model key state
  const [modelProvider, setModelProvider] = useState<ModelProvider>("anthropic");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelConfigured, setModelConfigured] = useState(false);
  const [modelLast4, setModelLast4] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<TestResult | null>(null);
  const [modelSaveError, setModelSaveError] = useState<string | null>(null);
  const [modelTestedCandidate, setModelTestedCandidate] = useState<{
    provider: ModelProvider;
    apiKey: string;
  } | null>(null);

  const canSaveSandbox = Boolean(
    sandboxTestResult?.ok &&
      sandboxTestedCandidate &&
      sandboxTestedCandidate.url === runnerUrl &&
      sandboxTestedCandidate.token === runnerToken &&
      runnerUrl &&
      runnerToken
  );

  const canSaveModel = Boolean(
    modelTestResult?.ok &&
      modelTestedCandidate &&
      modelTestedCandidate.provider === modelProvider &&
      modelTestedCandidate.apiKey === modelApiKey &&
      modelApiKey
  );

  const testSandbox = useCallback(async (): Promise<TestResult> => {
    setTestingSandbox(true);
    setSandboxTestResult(null);
    setSandboxSaveError(null);
    try {
      const payload = runnerUrl && runnerToken ? { runnerUrl, runnerToken } : {};
      const res = await fetch("/api/org/sandbox/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      const ok = Boolean(data.ok);
      const msg = data.error || data.message || (ok ? "Connected" : `Test failed (${res.status})`);
      const result: TestResult = { ok, message: msg };
      setSandboxTestResult(result);
      if (ok && runnerUrl && runnerToken) {
        setSandboxTestedCandidate({ url: runnerUrl, token: runnerToken });
      } else {
        setSandboxTestedCandidate(null);
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Network error";
      const result: TestResult = { ok: false, message };
      setSandboxTestResult(result);
      setSandboxTestedCandidate(null);
      return result;
    } finally {
      setTestingSandbox(false);
    }
  }, [runnerUrl, runnerToken]);

  const saveSandbox = useCallback(async (): Promise<SaveSandboxResponse> => {
    setSavingSandbox(true);
    setSandboxSaveError(null);
    try {
      const res = await fetch("/api/org/sandbox", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "computesdk",
          computesdkBackend: runnerBackend,
          runnerUrl,
          runnerToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        settings?: {
          runnerUrl?: string;
          runnerTokenMeta?: { configured: boolean; last4?: string };
        };
      };
      if (!res.ok || !data.ok) {
        const errText = data.error || `Save failed (${res.status})`;
        setSandboxSaveError(errText);
        return { ok: false, error: errText };
      }
      setSandboxConfigured(true);
      setSandboxLast4(data.settings?.runnerTokenMeta?.last4 ?? null);
      setRunnerToken(""); // write-only secret cleared from memory
      setSandboxTestedCandidate(null);
      return { ok: true, settings: data.settings };
    } catch (e) {
      const errText = e instanceof Error ? e.message : "Save failed";
      setSandboxSaveError(errText);
      return { ok: false, error: errText };
    } finally {
      setSavingSandbox(false);
    }
  }, [runnerBackend, runnerUrl, runnerToken]);

  const testModel = useCallback(async (): Promise<TestResult> => {
    setTestingModel(true);
    setModelTestResult(null);
    setModelSaveError(null);
    try {
      const res = await fetch("/api/org/model-keys/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: modelProvider,
          ...(modelApiKey ? { apiKey: modelApiKey } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      const ok = Boolean(data.ok);
      const msg = data.error || data.message || (ok ? "Connected" : `Test failed (${res.status})`);
      const result: TestResult = { ok, message: msg };
      setModelTestResult(result);
      if (ok && modelApiKey) {
        setModelTestedCandidate({ provider: modelProvider, apiKey: modelApiKey });
      } else {
        setModelTestedCandidate(null);
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Network error";
      const result: TestResult = { ok: false, message };
      setModelTestResult(result);
      setModelTestedCandidate(null);
      return result;
    } finally {
      setTestingModel(false);
    }
  }, [modelProvider, modelApiKey]);

  const saveModel = useCallback(async (): Promise<SaveModelResponse> => {
    setSavingModel(true);
    setModelSaveError(null);
    try {
      const res = await fetch(`/api/org/model-keys/${modelProvider}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: modelApiKey }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        key?: { configured: boolean; last4?: string };
      };
      if (!res.ok || !data.ok) {
        const errText = data.error || `Save failed (${res.status})`;
        setModelSaveError(errText);
        return { ok: false, error: errText };
      }
      setModelConfigured(true);
      setModelLast4(data.key?.last4 ?? null);
      setModelApiKey(""); // write-only secret cleared from memory
      setModelTestedCandidate(null);
      return { ok: true, key: data.key };
    } catch (e) {
      const errText = e instanceof Error ? e.message : "Save failed";
      setModelSaveError(errText);
      return { ok: false, error: errText };
    } finally {
      setSavingModel(false);
    }
  }, [modelProvider, modelApiKey]);

  return {
    runnerUrl,
    setRunnerUrl,
    runnerToken,
    setRunnerToken,
    runnerBackend,
    setRunnerBackend,
    sandboxConfigured,
    sandboxLast4,
    testingSandbox,
    savingSandbox,
    sandboxTestResult,
    sandboxSaveError,
    canSaveSandbox,
    testSandbox,
    saveSandbox,

    modelProvider,
    setModelProvider,
    modelApiKey,
    setModelApiKey,
    modelConfigured,
    modelLast4,
    testingModel,
    savingModel,
    modelTestResult,
    modelSaveError,
    canSaveModel,
    testModel,
    saveModel,
  };
}
