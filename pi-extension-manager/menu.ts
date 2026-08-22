/**
 * The /extensions menu: a searchable extension list with per-extension actions.
 *
 * Two views live in one overlay component:
 *  - "list": search input + extension list
 *  - "actions": action menu for the selected extension
 *
 * Long-running work (version check, update, delete) runs inline so the menu
 * stays open, with a status line under the header.
 */
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	checkVersion,
	deleteEntry,
	deleteTarget,
	effectiveSnapshot,
	hasUpdate,
	isDownloaded,
	isOffline,
	isPinnedNpm,
	isSelf,
	loadRegistry,
	readLocalVersion,
	setEnabled,
	updatePackage,
	type ExtensionEntry,
	type Registry,
} from "./registry.ts";

type Action = "toggle" | "version" | "update" | "delete";

interface ActionItem {
	id: Action;
	label: string;
	description: string;
	disabled?: string;
}

const KIND_LABELS: Record<ExtensionEntry["kind"], string> = {
	npm: "npm",
	git: "git",
	"local-package": "local package",
	"settings-path": "settings path",
	auto: "local file",
};

function versionSummary(entry: ExtensionEntry): string {
	if (!isDownloaded(entry)) return "";
	if (entry.versionState === "checking") return "checking…";
	if (entry.versionState === "error") return `version check failed`;
	if (entry.versionState === "checked") {
		const local = entry.localVersion ?? "?";
		const remote = entry.remoteVersion ?? "?";
		return local === remote ? `${local} (up to date)` : `${local} → ${remote}`;
	}
	return entry.localVersion ? `${entry.localVersion}` : "";
}

class ExtensionManagerComponent extends Container implements Focusable {
	private view: "list" | "actions" = "list";
	private search = new Input();
	private filtered: ExtensionEntry[] = [];
	private selected = 0;
	private actionIndex = 0;
	private status: { text: string; tone: "info" | "success" | "error" } | undefined;
	private busy = false;
	/** Pending destructive confirmation, kept inline so the menu never closes. */
	private confirming: { entry: ExtensionEntry; message: string } | undefined;
	/** Set of enabled extensions as it was when the menu opened. */
	private baseline: string;
	/**
	 * Set when a package's contents changed on disk (update). The enabled-path set
	 * can stay identical in that case, so a reload is still needed.
	 */
	private contentChanged = false;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value && this.view === "list";
	}

	constructor(
		private pi: ExtensionAPI,
		private ctx: ExtensionCommandContext,
		private registry: Registry,
		private tui: TUI,
		private theme: Theme,
		private done: (changed: boolean) => void,
	) {
		super();
		this.baseline = effectiveSnapshot(registry);
		this.applyFilter();
	}

	/**
	 * Whether reloading would actually change anything. Toggling an extension off
	 * and back on rewrites settings but lands on the same effective state, so it
	 * must not trigger a reload prompt.
	 */
	private hasChanges(): boolean {
		return this.contentChanged || effectiveSnapshot(this.registry) !== this.baseline;
	}

	// -- data ---------------------------------------------------------------

	private applyFilter(): void {
		const query = this.search.getValue().trim();
		const entries = this.registry.entries;
		this.filtered = query
			? fuzzyFilter(
					entries,
					query,
					(entry) => `${entry.displayName} ${entry.source ?? ""} ${entry.scope}`,
				)
			: entries;
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	private get current(): ExtensionEntry | undefined {
		return this.filtered[this.selected];
	}

	private actionsFor(entry: ExtensionEntry): ActionItem[] {
		const downloaded = isDownloaded(entry);
		const downloadedOnly = downloaded ? undefined : "only for downloaded (npm/git) extensions";
		const offline = isOffline() ? "unavailable in offline mode" : undefined;
		return [
			{
				id: "toggle",
				label: entry.enabled ? "Disable" : "Enable",
				description: `${entry.enabled ? "Stop" : "Start"} loading this extension (${entry.scope} settings)`,
				// Disabling the manager from its own menu would remove the only way back in.
				disabled: entry.enabled && isSelf(entry) ? "the extension manager cannot disable itself" : undefined,
			},
			{
				id: "version",
				label: "Check version",
				description: "Compare your installed version against the remote",
				disabled: downloadedOnly ?? offline,
			},
			{
				id: "update",
				label: "Update",
				description: entry.pinnedRef
					? `Reconcile to pinned ref ${entry.pinnedRef}`
					: "Fetch and install the latest version",
				disabled:
					downloadedOnly ??
					offline ??
					(isPinnedNpm(entry) ? `pinned to ${entry.pinnedRef} in settings` : undefined),
			},
			{
				id: "delete",
				label: "Delete",
				description: deleteTarget(entry).label,
			},
		];
	}

	private setStatus(text: string, tone: "info" | "success" | "error" = "info"): void {
		this.status = { text, tone };
		this.tui.requestRender();
	}

	// -- actions ------------------------------------------------------------

	private async runAction(action: Action, entry: ExtensionEntry): Promise<void> {
		if (this.busy) return;
		const items = this.actionsFor(entry);
		const item = items.find((candidate) => candidate.id === action);
		if (item?.disabled) {
			this.setStatus(`${item.label}: ${item.disabled}`, "error");
			return;
		}

		if (action === "delete") {
			this.confirming = {
				entry,
				message: `Really ${deleteTarget(entry).label}?`,
			};
			this.tui.requestRender();
			return;
		}

		this.busy = true;
		try {
			if (action === "toggle") {
				const next = !entry.enabled;
				await setEnabled(this.registry, entry, next);
				this.setStatus(`${entry.displayName} ${next ? "enabled" : "disabled"}`, "success");
			} else if (action === "version") {
				entry.versionState = "checking";
				this.setStatus(`Checking ${entry.displayName}…`);
				try {
					const info = await checkVersion(this.pi, this.registry, entry);
					entry.localVersion = info.local;
					entry.remoteVersion = info.remote;
					entry.versionState = "checked";
					this.setStatus(
						hasUpdate(entry)
							? `${entry.displayName}: local ${info.local ?? "?"} · remote ${info.remote ?? "?"} — update available`
							: `${entry.displayName}: local ${info.local ?? "?"} · remote ${info.remote ?? "?"}`,
						hasUpdate(entry) ? "info" : "success",
					);
				} catch (error) {
					entry.versionState = "error";
					entry.versionError = error instanceof Error ? error.message : String(error);
					this.setStatus(`Version check failed: ${entry.versionError}`, "error");
				}
			} else if (action === "update") {
				this.setStatus(`Updating ${entry.source}…`);
				const before = entry.localVersion;
				await updatePackage(this.registry, entry);
				this.contentChanged = true;
				entry.versionState = "idle";
				entry.remoteVersion = undefined;
				entry.localVersion = readLocalVersion(entry);
				const changed = entry.localVersion && entry.localVersion !== before;
				this.setStatus(
					changed
						? `Updated ${entry.source} to ${entry.localVersion} — /reload to pick it up`
						: `Updated ${entry.source} — /reload to pick it up`,
					"success",
				);
			}
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private async confirmDelete(): Promise<void> {
		if (this.busy) return;
		const pending = this.confirming;
		this.confirming = undefined;
		if (!pending) return;
		this.busy = true;
		this.setStatus(`Deleting ${pending.entry.displayName}…`);
		try {
			const message = await deleteEntry(this.registry, pending.entry);
			this.registry = await loadRegistry(this.ctx);
			// The deleted entry may have been the only search match; show the full list again.
			if (this.search.getValue()) this.search.setValue("");
			this.selected = 0;
			this.applyFilter();
			this.view = "list";
			this.search.focused = this._focused;
			this.setStatus(`${message} — /reload to apply`, "success");
		} catch (error) {
			this.setStatus(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	// -- input --------------------------------------------------------------

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.confirming) {
			// Deliberately not enter-to-confirm: a stray second Enter after picking
			// "Delete" must not destroy anything. Explicit y is required.
			if (data === "y" || data === "Y") {
				void this.confirmDelete();
			} else if (data === "n" || data === "N" || kb.matches(data, "tui.select.cancel")) {
				this.confirming = undefined;
				this.setStatus("Delete cancelled");
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.done(this.hasChanges());
			return;
		}

		if (this.view === "actions") {
			this.handleActionsInput(data, kb);
			return;
		}
		this.handleListInput(data, kb);
		this.tui.requestRender();
	}

	private handleListInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		if (kb.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selected = Math.min(this.filtered.length - 1, this.selected + 1);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(this.hasChanges());
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.current) {
				this.view = "actions";
				this.actionIndex = 0;
				this.search.focused = false;
				this.status = undefined;
			}
			return;
		}
		// Space toggles straight from the list as a shortcut.
		if (data === " " && this.search.getValue().length === 0) {
			const entry = this.current;
			if (entry) void this.runAction("toggle", entry);
			return;
		}
		this.search.handleInput(data);
		this.applyFilter();
	}

	private handleActionsInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		const entry = this.current;
		if (!entry) {
			this.view = "list";
			return;
		}
		const items = this.actionsFor(entry);
		if (kb.matches(data, "tui.select.up")) {
			this.actionIndex = Math.max(0, this.actionIndex - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.actionIndex = Math.min(items.length - 1, this.actionIndex + 1);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.view = "list";
			this.search.focused = this._focused;
		} else if (kb.matches(data, "tui.select.confirm")) {
			void this.runAction(items[this.actionIndex]!.id, entry);
		}
		this.tui.requestRender();
	}

	// -- render -------------------------------------------------------------

	invalidate(): void {
		this.search.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const border = "─".repeat(Math.max(1, width));
		lines.push(theme.fg("border", border));

		const title = theme.bold("Extensions");
		const count = theme.fg(
			"muted",
			`${this.filtered.length}/${this.registry.entries.length}`,
		);
		const hint = theme.fg(
			"dim",
			this.busy
				? "working…"
				: this.view === "list"
					? "type to search · enter actions · space toggle · esc close"
					: "enter run · esc back",
		);
		const left = `${title} ${count}`;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(hint));
		lines.push(truncateToWidth(`${left}${" ".repeat(gap)}${hint}`, width, ""));

		if (this.status) {
			const tone = this.status.tone === "success" ? "success" : this.status.tone === "error" ? "error" : "muted";
			lines.push(truncateToWidth(theme.fg(tone, this.status.text), width, "…"));
		}
		lines.push("");

		if (this.confirming) {
			lines.push(truncateToWidth(theme.fg("warning", theme.bold(this.confirming.message)), width, "…"));
			lines.push(theme.fg("dim", "y confirm · n cancel"));
			lines.push(theme.fg("border", border));
			return lines;
		}

		lines.push(...(this.view === "list" ? this.renderList(width) : this.renderActions(width)));
		lines.push(theme.fg("border", border));
		return lines;
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const lines = this.search.render(width);
		lines.push("");

		if (this.filtered.length === 0) {
			lines.push(theme.fg("muted", "  No extensions match"));
			return lines;
		}

		const maxVisible = Math.max(
			5,
			Math.min(this.filtered.length, (this.tui.terminal?.rows ?? 24) - 12),
		);
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filtered.length);

		for (let i = start; i < end; i++) {
			const entry = this.filtered[i]!;
			const isSelected = i === this.selected;
			const cursor = isSelected ? theme.fg("accent", "> ") : "  ";
			const checkbox = entry.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			const name = isSelected ? theme.fg("accent", theme.bold(entry.displayName)) : entry.displayName;
			const meta: string[] = [KIND_LABELS[entry.kind], entry.scope];
			const version = versionSummary(entry);
			if (version) meta.push(version);
			const suffix = theme.fg(hasUpdate(entry) ? "warning" : "muted", `  ${meta.join(" · ")}`);
			lines.push(truncateToWidth(`${cursor}${checkbox} ${name}${suffix}`, width, "…"));
		}

		if (start > 0 || end < this.filtered.length) {
			lines.push(theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`));
		}
		return lines;
	}

	private renderActions(width: number): string[] {
		const theme = this.theme;
		const entry = this.current;
		if (!entry) return [theme.fg("muted", "  Nothing selected")];
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.bold(entry.displayName)}`, width, "…"));
		const details = [
			`${KIND_LABELS[entry.kind]} · ${entry.scope}`,
			entry.source ?? entry.path,
		];
		if (entry.pinnedRef) details.push(`pinned ${entry.pinnedRef}`);
		const version = versionSummary(entry);
		if (version) details.push(version);
		lines.push(truncateToWidth(theme.fg("muted", `  ${details.join(" · ")}`), width, "…"));
		lines.push("");

		const items = this.actionsFor(entry);
		for (const [index, item] of items.entries()) {
			const isSelected = index === this.actionIndex;
			const cursor = isSelected ? theme.fg("accent", "> ") : "  ";
			const label = item.disabled
				? theme.fg("dim", item.label)
				: isSelected
					? theme.fg("accent", theme.bold(item.label))
					: item.label;
			const description = theme.fg("dim", `  ${item.disabled ?? item.description}`);
			lines.push(truncateToWidth(`${cursor}${label}${description}`, width, "…"));
		}
		return lines;
	}
}

export async function showExtensionManager(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/extensions requires the interactive TUI", "error");
		return;
	}

	const registry = await loadRegistry(ctx);
	if (registry.entries.length === 0) {
		ctx.ui.notify("No extensions found", "warning");
		return;
	}

	const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const component = new ExtensionManagerComponent(pi, ctx, registry, tui, theme, done);
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(component);
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => component.handleInput(data),
			get focused() {
				return component.focused;
			},
			set focused(value: boolean) {
				component.focused = value;
			},
		} as Component & Focusable;
	});

	if (changed) {
		const reload = await ctx.ui.confirm(
			"Reload extensions?",
			"Extension configuration changed. Reload now to apply?",
		);
		if (reload) {
			await ctx.reload();
			return;
		}
		ctx.ui.notify("Changes saved — run /reload to apply", "info");
	}
}
