/**
 * pi-extension-manager — `/extensions` menu for managing pi extensions.
 *
 * Lists every extension pi resolves (packages, settings paths and
 * auto-discovered files), lets you search them, and exposes per-extension
 * actions: enable/disable, update, version comparison and delete.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showExtensionManager } from "./menu.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("extensions", {
		description: "Manage pi extensions (search, enable/disable, update, delete)",
		handler: async (_args, ctx) => {
			await showExtensionManager(pi, ctx);
		},
	});
}
