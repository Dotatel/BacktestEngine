import { useRef, useState } from "react";
import type { DesktopBridge } from "@/lib/desktop";
import {
  errorMessage,
  providerNames,
  type AgentProvider,
} from "@/lib/preferences";

/** Own optional connection feedback and cancellation; stale provider responses never become live connection evidence. */
export function useAgentConnection(bridge: DesktopBridge) {
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);

  /** Clear obsolete provider feedback when the user chooses another option; does not mutate stored preferences. */
  function clear() {
    setMessage("");
    setError("");
  }

  /** Verify the selected local provider, returning evidence only for the current uncanceled request. */
  async function connect(provider: AgentProvider) {
    if (pending.current) return null;
    const requestGeneration = ++generation.current;
    pending.current = true;
    setConnecting(true);
    setError("");
    setMessage("Checking your local agent connection…");
    try {
      const connection = await bridge.connectAgent(provider);
      if (requestGeneration !== generation.current) return null;
      setMessage(
        `${providerNames[connection.provider]} ${connection.version} is connected. No prompts or project data have been sent.`,
      );
      return connection;
    } catch (failure) {
      if (requestGeneration !== generation.current) return null;
      setError(errorMessage(failure));
      setMessage("");
      return null;
    } finally {
      if (requestGeneration === generation.current) {
        pending.current = false;
        setConnecting(false);
      }
    }
  }

  /** Invalidate a request before canceling its host process; a late result cannot change the selected provider. */
  async function cancel() {
    ++generation.current;
    try {
      await bridge.cancelConnection();
    } catch (failure) {
      setError(errorMessage(failure));
    }
    pending.current = false;
    setConnecting(false);
    setMessage("Connection canceled. You can retry or skip for now.");
  }

  return { connecting, message, error, connect, cancel, clear };
}
