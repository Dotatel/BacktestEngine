# Workspace review remarks

The owner's annotated review requested functional application menus, cleaner Explorer overflow and familiar file-tab closure. The parameter inspector and results layout were outside the requested changes.

The workspace caption now exposes File, Edit, View, Window and Help. Commands reuse the existing project/document controller, Monaco's public actions, layout toggles and the guarded native window operations. Standard shadcn Menubar and Context Menu source reuse installed Radix primitives for keyboard navigation, focus, portals and dismissal. No package or backend replacement is involved. See the official [Menubar](https://ui.shadcn.com/docs/components/radix/menubar) and [Context Menu](https://ui.shadcn.com/docs/components/radix/context-menu) documentation.

The header uses the plain workspace background. The menu strip is transparent; dropdowns retain a readable surface without a border or shadow. Hover and keyboard focus remain visible. The approved onboarding artwork stays separate.

Native rapid-input checks exposed a risk in replaying controlled React drafts into Monaco. Monaco now owns its live buffer while changes still synchronously update the save controller. Authoritative reads use a monotonic reset identity, including reload after rename; ordinary saves preserve the active cursor and undo stack.

The native host explicitly creates its configured local main window with Tauri's built-in [clipboard access option](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.enable_clipboard_access). This allows Monaco's existing Web Clipboard API commands on Windows. All configured window properties and the local-only content policy remain in place; no clipboard plugin or custom editor clipboard implementation is added.

The native maximize observer subscribes before its first state read, preventing startup maximization from being missed. It ignores older asynchronous results and results after disposal, releases a subscription when initialization fails, and reports later query failures through the existing error channel. Caption controls and Window commands share this state.

Each tab has its own close control and a right-click menu for Close, Close Others, Close to Right and Close All. Bulk closure captures the requested open files, saves only that set when requested, and preserves all selected tabs on cancellation, conflict or an incomplete save. Historical results and current editor drafts stay separate.

Explorer's outer padding had been included in the measured Arborist viewport and then added outside it again. Its rows also imposed a content-based minimum width. The corrected single viewport fits short file lists, retains scrolling for larger lists and truncates long row labels within the sidebar. Drag/drop, keyboard navigation and resize behavior remain part of verification.

## Side destinations to plan separately

Markets, Data and Strategy are disabled placeholders in `WorkspaceRail.tsx`. They do not yet have dedicated pages or navigation handlers. The underlying application already provides historical import/price preview in Backtest and source editing/reflection in Build. A dedicated instrument browser, dataset library/import workflow and strategy-management workflow still need their own agreed scope and UI before these rail destinations can be enabled. This change does not implement them.

## Verification scope

Focused tests cover dirty-tab cancellation, targeted saves, revision conflicts, pending-save protection, keyboard/context-menu actions and current menu availability. Browser checks use actual locally bundled Monaco, isolated preview storage, both themes and supported compact/wide layouts. Native review uses a rebuilt executable with separate settings; the owner's previous review copy is preserved. Exact generated reports remain in ignored `artifacts/`. These UI checks do not establish financial replay or trading parity.
