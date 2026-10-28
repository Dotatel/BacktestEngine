import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";

/** Group related preferences with their purpose beside the actual setting rows. */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="app-settings-section" aria-labelledby={id}>
      <div className="app-settings-section__intro">
        <h2 id={id}>{title}</h2>
        <p className="app-settings-note">{description}</p>
      </div>
      <div className="app-settings-section__rows">{children}</div>
    </section>
  );
}

/** Align one setting's label and explanation with its standard shadcn control or read-only value. */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="app-settings-row">
      <div className="app-settings-row__copy">
        {htmlFor ? (
          <Label htmlFor={htmlFor}>{label}</Label>
        ) : (
          <p className="app-settings-row__label">{label}</p>
        )}
        <p className="app-settings-note">{description}</p>
      </div>
      <div className="app-settings-row__control">{children}</div>
    </div>
  );
}
