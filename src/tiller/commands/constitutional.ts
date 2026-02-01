/**
 * Constitutional command - manage constitutional knowledge files
 */

import type { Command } from "commander";
import {
	getConstitutionalDir,
	initDefaultConstitutional,
	outputConstitutional,
	readConstitutionalFiles,
} from "../state/constitutional.js";

export function registerConstitutionalCommands(program: Command): void {
	program
		.command("constitutional")
		.description("Show constitutional knowledge files")
		.option("--init", "Initialize default constitutional files")
		.action((options: { init?: boolean }) => {
			if (options.init) {
				initDefaultConstitutional();
				console.log(
					`Initialized constitutional files in ${getConstitutionalDir()}/`,
				);
				return;
			}

			const contents = readConstitutionalFiles();
			if (contents.length === 0) {
				console.log(
					"No constitutional files. Run: tiller constitutional --init",
				);
				return;
			}

			outputConstitutional();
		});
}
