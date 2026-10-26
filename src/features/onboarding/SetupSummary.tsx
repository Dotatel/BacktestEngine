import { providerNames, type Preferences } from "@/lib/preferences";

/** Describe actual provider state without treating a selected or previously saved provider as a verified connection. */
function describeAgent(preferences: Preferences) {
  if (!preferences.agent) return "Skipped for now";
  const status = preferences.agentVerified ? "connected" : "not connected";
  return `${providerNames[preferences.agent]} · ${status}`;
}

/** Render actual setup choices in finish/returning-user screens without storage or native operations. */
export function SetupSummary({ preferences }: { preferences: Preferences }) {
  const rows = [
    [
      "Workspace style",
      preferences.workspaceStyle === "simple" ? "Simple" : "Advanced",
    ],
    [
      "Appearance",
      preferences.appearance.charAt(0).toUpperCase() +
        preferences.appearance.slice(1),
    ],
    ["AI agent", describeAgent(preferences)],
  ];
  return (
    <dl className="setup-summary">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
