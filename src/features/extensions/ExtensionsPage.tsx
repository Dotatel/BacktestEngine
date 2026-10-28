import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  Blocks,
  Package,
  CircleSlash,
  FileChartColumn,
  MessageSquare,
  FolderOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExtensionsBridge } from "@/lib/extensions-contract";
import type { ReportsBridge } from "@/lib/reports-contract";
import { useExtensions } from "./useExtensions";
import {
  extensionCatalog,
  extensionState,
  type ExtensionCatalogItem,
} from "./extension-catalog";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionDetails } from "./ExtensionDetails";
import { ExtensionsFeedback } from "./ExtensionsFeedback";
import "./extensions.css";

const categories = [
  { key: "all", label: "All extensions", icon: Blocks },
  { key: "installed", label: "Installed", icon: Package },
  { key: "disabled", label: "Disabled", icon: CircleSlash },
  { key: "reports", label: "Reports", icon: FileChartColumn },
  { key: "assistants", label: "Assistants", icon: MessageSquare },
] as const;

/** Full-page local extension management and explicit navigation to preserved workspace surfaces. */
export interface ExtensionsPageProps {
  bridge: ExtensionsBridge;
  reportsBridge: ReportsBridge;
  projectRoot: string | null;
  onClose(): void;
  onGoToReports(): void;
  onOpenAssistant(): void;
}

/** Present a local catalog, real installations and honest provider previews without fetching a marketplace. */
export function ExtensionsPage(props: ExtensionsPageProps) {
  const controller = useExtensions(
    props.bridge,
    props.reportsBridge,
    props.projectRoot,
    true,
  );
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("All states");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [compact, setCompact] = useState(
    () => window.matchMedia?.("(max-width: 1100px)").matches ?? false,
  );
  const detailsId = useId();
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const visible = extensionCatalog(controller.entries).filter((item) =>
    matches(item, category, query, state),
  );
  const busy = controller.phase !== "idle";
  const selected = visible.find((item) => item.key === expandedKey);
  /** Dismiss the inspector without losing the card that opened it. */
  function closeDetails() {
    restoreFocus.current = true;
    setExpandedKey(null);
  }
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0 });
  }, [category]);
  useEffect(() => {
    if (selected || !restoreFocus.current) return;
    selectedTrigger.current?.focus({ preventScroll: true });
    restoreFocus.current = false;
  }, [selected]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1100px)");
    if (!media) return;
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return (
    <section
      className={`extensions-page${selected ? " extensions-page--details" : ""}`}
      aria-label="App extensions"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !selected)
          return;
        event.stopPropagation();
        closeDetails();
      }}
    >
      <aside className="extensions-sidebar">
        <div className="extensions-sidebar__heading">
          <h2>Extensions</h2>
          <p className="app-extensions-note">Experimental app extensions</p>
        </div>
        <nav
          className="extensions-categories"
          aria-label="Extension categories"
        >
          {categories.map(({ key, label, icon: Icon }) => (
            <div
              key={key}
              className={
                key === "reports" ? "extensions-category-group" : undefined
              }
            >
              {key === "reports" && (
                <p className="extensions-categories__label">Categories</p>
              )}
              <Button
                size="sm"
                variant={category === key ? "secondary" : "ghost"}
                aria-current={category === key ? "page" : undefined}
                onClick={() => {
                  setCategory(key);
                  setExpandedKey(null);
                }}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            </div>
          ))}
        </nav>
        <div className="extensions-sidebar__back">
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            <ArrowLeft aria-hidden="true" />
            Back to workspace
          </Button>
        </div>
      </aside>
      <div
        className="extensions-main"
        ref={main}
        inert={compact && Boolean(selected)}
      >
        <header className="extensions-heading">
          <div>
            <div className="extensions-heading__title">
              <h1 tabIndex={-1} ref={heading}>
                App extensions
              </h1>
              <span className="extension-badge">Experimental</span>
            </div>
            <p>Discover and manage report extensions for your workspace.</p>
          </div>
          <div className="app-extensions-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !props.bridge.native}
              onClick={() => void controller.importFolder()}
            >
              <FolderOpen aria-hidden="true" />
              Import folder
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || !props.bridge.native}
              aria-label="Refresh extensions"
              onClick={() => void controller.refresh()}
            >
              <RefreshCw
                className={
                  controller.phase === "loading" ? "spinner" : undefined
                }
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>
        <div className="extensions-toolbar">
          <div className="extensions-search">
            <Search aria-hidden="true" />
            <Input
              aria-label="Search extensions"
              placeholder="Search extensions…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setExpandedKey(null);
              }}
            />
          </div>
          <Select
            value={state}
            onValueChange={(value) => {
              setState(value);
              setExpandedKey(null);
            }}
          >
            <SelectTrigger aria-label="Extension state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                "All states",
                "Available",
                "Enabled",
                "Disabled",
                "Needs attention",
              ].map((value) => (
                <SelectItem value={value} key={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(!compact || !selected) && (
          <ExtensionsFeedback controller={controller} />
        )}
        <div className="extensions-browser">
          <div className="extensions-list-pane">
            <div className="extensions-list-heading">
              <h2>
                {category === "all"
                  ? "Available extensions"
                  : categories.find((item) => item.key === category)?.label}
              </h2>
              <span
                className="app-extensions-note"
                aria-label={`${visible.length} extensions`}
              >
                {visible.length}
              </span>
            </div>
            <div className="app-extensions-list" aria-label="Extensions list">
              {visible.map((item) => (
                <ExtensionCard
                  key={item.key}
                  item={item}
                  controller={controller}
                  native={props.bridge.native}
                  onOpenAssistant={props.onOpenAssistant}
                  expanded={expandedKey === item.key}
                  detailsId={detailsId}
                  onExpandedChange={(open, trigger) => {
                    selectedTrigger.current = trigger;
                    setExpandedKey(open ? item.key : null);
                  }}
                />
              ))}
              {!visible.length && (
                <div className="extensions-empty">
                  <h3>No matching extensions</h3>
                  <p className="app-extensions-note">
                    Try a different search or filter.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      setState("All states");
                      setCategory("all");
                      setExpandedKey(null);
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
            </div>
            <p className="extensions-catalog-note app-extensions-note">
              Examples are bundled with this app. Assistant previews do not
              install connectors.
            </p>
          </div>
        </div>
      </div>
      {selected && (
        <ExtensionDetails
          key={selected.key}
          id={detailsId}
          item={selected}
          controller={controller}
          native={props.bridge.native}
          canGoToReports={Boolean(props.projectRoot)}
          onGoToReports={props.onGoToReports}
          onClose={closeDetails}
          compact={compact}
          feedback={
            compact ? <ExtensionsFeedback controller={controller} /> : undefined
          }
        />
      )}
    </section>
  );
}

/** Combine independent text, category and registration-state filters without mutating native entries. */
function matches(
  item: ExtensionCatalogItem,
  category: string,
  query: string,
  state: string,
) {
  if (category === "installed" && !item.installed) return false;
  if (category === "disabled" && (!item.installed || item.installed.enabled))
    return false;
  if (
    (category === "reports" || category === "assistants") &&
    item.category !== category
  )
    return false;
  if (state !== "All states" && extensionState(item) !== state) return false;
  return `${item.name} ${item.description}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}
