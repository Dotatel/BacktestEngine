import { invoke, isTauri } from "@tauri-apps/api/core";

/** Explicit bounded scenario controls; native code resolves every input and output path. */
export interface FullValidationRequest {
  executionRunId: string;
  replayReceiptSha256: string;
  spreadMultipliers: number[];
  commissionMultipliers: number[];
  latencyTicks: number[];
  walkForward: {
    trainDays: number;
    validationDays: number;
    testDays: number;
    embargoDays: number;
  };
  monteCarloRuns: number;
  seed: number;
  gates: null;
}

/** Process completion and the original engine verdict are independent evidence. */
export interface FullValidationResult {
  validationRunId: string;
  executionRunId: string;
  projectRoot: string;
  replayReceiptSha256: string;
  sourceReportSha256: string;
  success: boolean;
  status: string;
  verdict: string;
  plannedScenarios: number;
  generatedWalkForwardWindows: number;
  excludedWalkForwardWindows: number;
  validationDirectory: string;
  errors: string[];
  output: string;
  evidence: { missingEvidence: string[] } | null;
}

/** Inject the real full-workflow lifecycle for desktop use and focused UI tests. */
export interface FullValidationBridge {
  native: boolean;
  run(request: FullValidationRequest): Promise<FullValidationResult>;
  cancel(): Promise<void>;
  lastGoodResult(): Promise<FullValidationResult | null>;
}

/** Browser previews provide no engine reruns or fabricated validation results. */
export const fullValidation: FullValidationBridge = {
  native: isTauri(),
  run: (request) =>
    isTauri()
      ? invoke("full_validation_run", { request })
      : Promise.reject(
          new Error("Engine scenario validation requires the desktop app."),
        ),
  cancel: () =>
    isTauri() ? invoke("full_validation_cancel") : Promise.resolve(),
  lastGoodResult: () =>
    isTauri()
      ? invoke("full_validation_last_good_result")
      : Promise.resolve(null),
};
