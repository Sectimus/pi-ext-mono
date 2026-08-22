/**
 * Discovery + mutation of pi extensions for the /extensions menu.
 *
 * Extensions are resolved through the same PackageManager pi uses at startup, so
 * enable/disable state, scope (user/project) and provenance (package vs local
 * file) match what `pi config` shows.
 */
import {
	existsSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	type PathMetadata,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type ExtensionKind =
	| "npm"
	| "git"
	| "local-package"
	| "settings-path"
	| "auto";
export type VersionState = "idle" | "checking" | "checked" | "error";

export interface ExtensionEntry {
	/** Absolute path of the extension file (or directory entry point). */
	path: string;
	displayName: string;
	enabled: boolean;
	metadata: PathMetadata;
	scope: "user" | "project";
	kind: ExtensionKind;
	/** Package source string as written in settings (npm:/git:/path). */
	source?: string;
	/** Where the package is installed on disk, when it is a downloaded one. */
	installedPath?: string;
	/** Pinned npm version or git ref, if the source carries one. */
	pinnedRef?: string;
	localVersion?: string;
	remoteVersion?: string;
	lastUpdated?: string;
	versionState: VersionState;
	versionError?: string;
}

export interface Registry {
	entries: ExtensionEntry[];
	settingsManager: SettingsManager;
	packageManager: DefaultPackageManager;
	agentDir: string;
	cwd: string;
}

/** Directory this extension's own source lives in, used to recognise itself in the list. */
const SELF_DIR = (() => {
	try {
		return realpathSync(dirname(fileURLToPath(import.meta.url)));
	} catch {
		return undefined;
	}
})();

/**
 * True for the extension manager itself. Disabling it from its own menu would
 * leave no way back in, so that action is refused.
 */
export function isSelf(entry: ExtensionEntry): boolean {
	if (!SELF_DIR) return false;
	try {
		const path = realpathSync(entry.path);
		return path === SELF_DIR || path.startsWith(SELF_DIR + sep);
	} catch {
		return false;
	}
}

/** Downloaded extensions are the only ones that can be updated or version-checked. */
export function isDownloaded(entry: ExtensionEntry): boolean {
	return entry.kind === "npm" || entry.kind === "git";
}

/** Exact npm versions are pinned in settings; pi's updater deliberately skips them. */
export function isPinnedNpm(entry: ExtensionEntry): boolean {
	return (
		entry.kind === "npm" &&
		!!entry.pinnedRef &&
		/^\d+\.\d+\.\d+/.test(entry.pinnedRef)
	);
}

/** Network actions are pointless when pi is running offline. */
export function isOffline(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return (
		value === "1" ||
		value.toLowerCase() === "true" ||
		value.toLowerCase() === "yes"
	);
}

export function hasUpdate(entry: ExtensionEntry): boolean {
	return (
		entry.versionState === "checked" &&
		!!entry.localVersion &&
		!!entry.remoteVersion &&
		entry.localVersion !== entry.remoteVersion
	);
}

function classify(metadata: PathMetadata): {
	kind: ExtensionKind;
	pinnedRef?: string;
} {
	if (metadata.origin === "top-level") {
		return { kind: metadata.source === "auto" ? "auto" : "settings-path" };
	}
	const source = metadata.source;
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		const at = spec.lastIndexOf("@");
		return { kind: "npm", pinnedRef: at > 0 ? spec.slice(at + 1) : undefined };
	}
	if (
		source.startsWith("git:") ||
		/^(https?|ssh|git):\/\//.test(source) ||
		source.startsWith("git@")
	) {
		const at = source.lastIndexOf("@");
		const slash = source.lastIndexOf("/");
		return {
			kind: "git",
			pinnedRef: at > slash && at > 6 ? source.slice(at + 1) : undefined,
		};
	}
	return { kind: "local-package" };
}

/** Short human label for a package source, e.g. `pi-web-access` or `user/repo`. */
function packageLabel(source: string, kind: ExtensionKind): string {
	if (kind === "npm") return npmPackageName(source);
	if (kind === "git") {
		const withoutRef = source.replace(/^git:/, "").replace(/^[a-z+]+:\/\//, "");
		const parts = withoutRef.split("/").filter(Boolean);
		return (
			parts
				.slice(-2)
				.join("/")
				.replace(/\.git$/, "") || withoutRef
		);
	}
	return basename(source);
}

function readPackageNameAt(dir: string): string | undefined {
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			name?: unknown;
		};
		return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

function nearestPackageDir(path: string): string | undefined {
	let dir = path;
	try {
		if (!statSync(dir).isDirectory()) dir = dirname(dir);
	} catch {
		dir = dirname(dir);
	}
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function packageNameForPath(path: string): string | undefined {
	const dir = nearestPackageDir(path);
	return dir ? readPackageNameAt(dir) : undefined;
}

function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function lastUpdatedForPath(path: string): string | undefined {
	const packageDir = nearestPackageDir(path);
	const target = packageDir ? join(packageDir, "package.json") : path;
	if (!existsSync(target)) return undefined;
	try {
		return formatDate(statSync(target).mtime);
	} catch {
		return undefined;
	}
}

function displayNameFor(
	path: string,
	metadata: PathMetadata,
	kind: ExtensionKind,
): string {
	const packageName = packageNameForPath(path);
	if (packageName) return packageName;
	const fileName = basename(path);
	if (metadata.origin === "package") {
		const inner = metadata.baseDir ? relative(metadata.baseDir, path) : fileName;
		return `${packageLabel(metadata.source, kind)}:${inner}`;
	}
	const parentFolder = basename(dirname(path));
	return parentFolder && parentFolder !== "extensions"
		? `${parentFolder}/${fileName}`
		: fileName;
}

export async function loadRegistry(ctx: ExtensionContext): Promise<Registry> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const packageManager = new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
	});
	// Never install anything just because the menu was opened.
	const resolved = await packageManager.resolve(async () => "skip");

	const entries: ExtensionEntry[] = resolved.extensions.map((resource) => {
		const scope: "user" | "project" =
			resource.metadata.scope === "project" ? "project" : "user";
		const { kind, pinnedRef } = classify(resource.metadata);
		const source =
			resource.metadata.origin === "package"
				? resource.metadata.source
				: undefined;
		const installedPath = source
			? packageManager.getInstalledPath(source, scope)
			: undefined;
		const entry: ExtensionEntry = {
			path: resource.path,
			displayName: displayNameFor(resource.path, resource.metadata, kind),
			enabled: resource.enabled,
			metadata: resource.metadata,
			scope,
			kind,
			source,
			installedPath,
			pinnedRef,
			lastUpdated: lastUpdatedForPath(installedPath ?? resource.path),
			versionState: "idle",
		};
		if (isDownloaded(entry)) entry.localVersion = readLocalVersion(entry);
		return entry;
	});

	entries.sort(
		(a, b) =>
			Number(isDownloaded(b)) - Number(isDownloaded(a)) ||
			a.displayName.localeCompare(b.displayName),
	);

	return { entries, settingsManager, packageManager, agentDir, cwd: ctx.cwd };
}

/**
 * A fingerprint of what pi would actually load right now: the set of enabled
 * extension paths. Comparing this before/after tells us whether a reload would
 * make any real difference, so a disable-then-enable round trip (which does
 * rewrite settings, but to an equivalent state) doesn't prompt for a reload.
 */
export function effectiveSnapshot(registry: Registry): string {
	return registry.entries
		.filter((entry) => entry.enabled)
		.map((entry) => entry.path)
		.sort()
		.join("\n");
}

function readNpmVersion(installedPath: string): string | undefined {
	const packageJsonPath = join(installedPath, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		return JSON.parse(readFileSync(packageJsonPath, "utf-8")).version as
			| string
			| undefined;
	} catch {
		return undefined;
	}
}

/** Read the on-disk version of a downloaded extension: npm version or short git sha. */
export function readLocalVersion(entry: ExtensionEntry): string | undefined {
	if (!entry.installedPath || !existsSync(entry.installedPath)) return undefined;
	if (entry.kind === "npm") return readNpmVersion(entry.installedPath);
	if (entry.kind !== "git") return undefined;
	try {
		const head = readFileSync(
			join(entry.installedPath, ".git", "HEAD"),
			"utf-8",
		).trim();
		if (!head.startsWith("ref: ")) return head.slice(0, 12);
		const ref = head.slice(5).trim();
		const refPath = join(entry.installedPath, ".git", ref);
		if (existsSync(refPath))
			return readFileSync(refPath, "utf-8").trim().slice(0, 12);
		const packed = readFileSync(
			join(entry.installedPath, ".git", "packed-refs"),
			"utf-8",
		);
		return packed
			.match(new RegExp(`^([0-9a-f]{40}) ${ref}$`, "m"))?.[1]
			?.slice(0, 12);
	} catch {
		return undefined;
	}
}

function npmPackageName(source: string): string {
	const spec = source.slice(4);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

function stripPattern(pattern: string): string {
	return pattern.startsWith("!") ||
		pattern.startsWith("+") ||
		pattern.startsWith("-")
		? pattern.slice(1)
		: pattern;
}

function topLevelBaseDir(
	registry: Registry,
	scope: "user" | "project",
): string {
	return scope === "project"
		? join(registry.cwd, CONFIG_DIR_NAME)
		: registry.agentDir;
}

/**
 * Persist a new enabled state for a single extension file.
 *
 * Top-level extension paths still need `-path` entries to opt out of
 * auto-discovered files. Package extension lists are simpler: keep only the
 * enabled paths and omit the rest.
 */
export async function setEnabled(
	registry: Registry,
	entry: ExtensionEntry,
	enabled: boolean,
): Promise<void> {
	const { settingsManager } = registry;
	if (entry.metadata.origin === "top-level") {
		const settings =
			entry.scope === "project"
				? settingsManager.getProjectSettings()
				: settingsManager.getGlobalSettings();
		const baseDir =
			entry.metadata.baseDir ?? topLevelBaseDir(registry, entry.scope);
		const pattern = relative(baseDir, entry.path);
		const updated = (settings.extensions ?? []).filter(
			(p) => stripPattern(p) !== pattern,
		);
		updated.push(`${enabled ? "+" : "-"}${pattern}`);
		if (entry.scope === "project")
			settingsManager.setProjectExtensionPaths(updated);
		else settingsManager.setExtensionPaths(updated);
	} else {
		const settings =
			entry.scope === "project"
				? settingsManager.getProjectSettings()
				: settingsManager.getGlobalSettings();
		const packages = [...(settings.packages ?? [])];
		const index = packages.findIndex(
			(pkg) =>
				(typeof pkg === "string" ? pkg : pkg.source) === entry.metadata.source,
		);
		if (index === -1)
			throw new Error(`Package not found in settings: ${entry.metadata.source}`);
		let pkg = packages[index]!;
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[index] = pkg;
		}
		const baseDir = entry.metadata.baseDir ?? dirname(entry.path);
		const pattern = relative(baseDir, entry.path);
		const updated = (pkg.extensions ?? []).filter(
			(p) => stripPattern(p) !== pattern,
		);
		if (enabled) updated.push(pattern);
		pkg.extensions = updated;
		if (entry.scope === "project") settingsManager.setProjectPackages(packages);
		else settingsManager.setPackages(packages);
	}
	await settingsManager.flush();
	entry.enabled = enabled;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface VersionInfo {
	local?: string;
	remote?: string;
}

/** Resolve local + remote versions for a downloaded extension (npm version / git sha). */
export async function checkVersion(
	pi: ExtensionAPI,
	registry: Registry,
	entry: ExtensionEntry,
	signal?: AbortSignal,
): Promise<VersionInfo> {
	if (!entry.installedPath || !existsSync(entry.installedPath)) {
		throw new Error("Package is not installed on disk");
	}
	if (entry.kind === "npm") {
		const local = readNpmVersion(entry.installedPath);
		const npmCommand = registry.settingsManager.getNpmCommand() ?? ["npm"];
		const [command, ...prefixArgs] = npmCommand as [string, ...string[]];
		const spec = entry.pinnedRef
			? entry.source!.slice(4)
			: npmPackageName(entry.source!);
		const result = await pi.exec(
			command,
			[...prefixArgs, "view", spec, "version", "--json"],
			{
				cwd: registry.cwd,
				signal,
				timeout: 30_000,
			},
		);
		if (result.code !== 0)
			throw new Error(result.stderr.trim() || "npm view failed");
		let parsed: unknown = "";
		try {
			parsed = JSON.parse(result.stdout.trim() || '""');
		} catch {
			throw new Error("npm view returned invalid JSON");
		}
		const remote = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
		return {
			local,
			remote: typeof remote === "string" && remote ? remote : undefined,
		};
	}

	const localHead = await pi.exec("git", ["rev-parse", "HEAD"], {
		cwd: entry.installedPath,
		signal,
		timeout: 30_000,
	});
	const ref = entry.pinnedRef ?? "HEAD";
	const remoteHead = await pi.exec("git", ["ls-remote", "origin", ref], {
		cwd: entry.installedPath,
		signal,
		timeout: 30_000,
	});
	if (remoteHead.code !== 0)
		throw new Error(remoteHead.stderr.trim() || "git ls-remote failed");
	const remoteSha = remoteHead.stdout.match(/^([0-9a-f]{40})\s+/m)?.[1];
	return {
		local:
			localHead.code === 0 ? localHead.stdout.trim().slice(0, 12) : undefined,
		remote: remoteSha?.slice(0, 12),
	};
}

// ---------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------

export async function updatePackage(
	registry: Registry,
	entry: ExtensionEntry,
): Promise<void> {
	if (!entry.source) throw new Error("Not a package extension");
	await registry.packageManager.update(entry.source);
}

export type DeleteTarget =
	| { type: "package"; label: string }
	| { type: "settings-path"; label: string }
	| { type: "file"; label: string };

/** What "delete" means for this entry — packages are uninstalled, loose files removed. */
export function deleteTarget(entry: ExtensionEntry): DeleteTarget {
	if (entry.metadata.origin === "package") {
		return {
			type: "package",
			label: `uninstall package ${entry.metadata.source}`,
		};
	}
	if (entry.kind === "settings-path") {
		return { type: "settings-path", label: `remove ${entry.path} from settings` };
	}
	return { type: "file", label: `permanently delete ${entry.path} from disk` };
}

export async function deleteEntry(
	registry: Registry,
	entry: ExtensionEntry,
): Promise<string> {
	const target = deleteTarget(entry);
	if (target.type === "package") {
		await registry.packageManager.removeAndPersist(entry.metadata.source, {
			local: entry.scope === "project",
		});
		return `Uninstalled ${entry.metadata.source}`;
	}
	if (target.type === "settings-path") {
		await removeSettingsPatterns(registry, entry);
		return `Removed ${entry.displayName} from settings`;
	}
	// Auto-discovered file or directory in an extensions/ folder.
	const isDir = existsSync(entry.path) && statSync(entry.path).isDirectory();
	const parent = dirname(entry.path);
	const removeTarget =
		!isDir && basename(parent) !== "extensions" ? parent : entry.path;
	rmSync(removeTarget, { recursive: true, force: true });
	// Drop any leftover +/- pattern so settings don't reference a missing file.
	await removeSettingsPatterns(registry, entry);
	return `Deleted ${removeTarget}`;
}

/** Remove every `extensions` pattern in the entry's scope that points at it. */
async function removeSettingsPatterns(
	registry: Registry,
	entry: ExtensionEntry,
): Promise<void> {
	const { settingsManager } = registry;
	const settings =
		entry.scope === "project"
			? settingsManager.getProjectSettings()
			: settingsManager.getGlobalSettings();
	const current = settings.extensions ?? [];
	const baseDir =
		entry.metadata.baseDir ?? topLevelBaseDir(registry, entry.scope);
	const candidates = new Set([entry.path, relative(baseDir, entry.path)]);
	const updated = current.filter((p) => !candidates.has(stripPattern(p)));
	if (updated.length === current.length) return;
	if (entry.scope === "project")
		settingsManager.setProjectExtensionPaths(updated);
	else settingsManager.setExtensionPaths(updated);
	await settingsManager.flush();
}
