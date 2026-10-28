import { ChevronRight } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { ExtensionAction } from "./ExtensionAction";
import { ExtensionIcon } from "./ExtensionIcon";
import { extensionOrigin, extensionState } from "./extension-catalog";

/** Select a compact card for the right inspector while keeping lifecycle actions independent. */
export function ExtensionCard(
  props: ComponentProps<typeof ExtensionAction> & {
    expanded: boolean;
    detailsId: string;
    onExpandedChange(open: boolean, trigger: HTMLButtonElement): void;
  },
) {
  const { item, expanded, onExpandedChange } = props;
  const id = useId();
  return (
    <article
      className="extension-card"
      aria-label={item.name}
      data-selected={expanded}
    >
      <div className="extension-card__summary">
        <ExtensionIcon item={item} />
        <div className="extension-card__copy">
          <button
            type="button"
            className="extension-card__toggle"
            aria-label={`View ${item.name}`}
            aria-describedby={`${id}-metadata ${id}-description`}
            aria-expanded={expanded}
            aria-controls={expanded ? props.detailsId : undefined}
            onClick={(event) =>
              onExpandedChange(!expanded, event.currentTarget)
            }
          >
            <span className="extension-card__name">{item.name}</span>
          </button>
          <span className="app-extensions-note" id={`${id}-metadata`}>
            {extensionOrigin(item)} · {item.version}
          </span>
          <span
            className="extension-card__description"
            id={`${id}-description`}
          >
            {item.description}
          </span>
          <span className="extension-card__hint" id={`${id}-hint`}>
            <ChevronRight aria-hidden="true" />
            {expanded ? "Hide details" : "View details"}
            {item.installed && ` · ${extensionState(item)}`}
          </span>
        </div>
        <div className="extension-card__actions">
          <ExtensionAction {...props} />
        </div>
      </div>
    </article>
  );
}
