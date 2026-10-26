/** Explicit manual release-check outcome; source/network failure is never up-to-date. */
export interface ReleaseCheck {
  status:
    | "disabled"
    | "noRelease"
    | "rateLimited"
    | "error"
    | "upToDate"
    | "updateAvailable";
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string | null;
  message: string;
  releaseUrl: string | null;
  downloadUrl: string | null;
  notes: string | null;
  dismissed: boolean;
}

/** No background polling or installation exists; each check requires explicit opt-in and intent. */
export interface UpdatesBridge {
  native: boolean;
  checkNow(): Promise<ReleaseCheck>;
  dismiss(version: string): Promise<void>;
  openRelease(url: string): Promise<void>;
}
