import assert = require("assert");
import { emptyDir } from "fs-extra";
import * as yargs from "yargs";

import NpmClient from "./lib/npm-client";
import { clearOutputPath } from "./lib/package-generator";
import { AllPackages, TypingsData } from "./lib/packages";
import { outputPath, validateOutputPath } from "./lib/settings";
import { fetchNpmInfo } from "./lib/versions";
import { assertDirectoriesEqual, npmInstallFlags, writeJson } from "./util/io";
import { Logger, logger, writeLog } from "./util/logging";
import { computeHash, done, execAndThrowErrors, joinPaths } from "./util/util";

const packageName = "types-registry";
const registryOutputPath = joinPaths(outputPath, packageName);
const readme =
`This package contains a listing of all packages published to the @types scope on NPM.
Generated by [types-publisher](https://github.com/Microsoft/types-publisher).`;

if (!module.parent) {
	const dry = !!yargs.argv.dry;
	done(main(dry));
}

export default async function main(dry: boolean): Promise<void> {
	const [log, logResult] = logger();
	log("=== Publishing types-registry ===");

	const { version: oldVersion, contentHash: oldContentHash } = await fetchNpmInfo(packageName);

	// Don't include not-needed packages in the registry.
	const typings = await AllPackages.readTypings();
	const registry = generateRegistry(typings);
	const newContentHash = computeHash(JSON.stringify(registry, undefined, 4));

	assert.equal(oldVersion.major, 0);
	assert.equal(oldVersion.minor, 1);
	const newVersion = `0.1.${oldVersion.patch + 1}`;
	const packageJson = generatePackageJson(newVersion, newContentHash);
	await generate(registry, packageJson, log);

	if (oldContentHash !== newContentHash) {
		log("New packages have been added, so publishing a new registry.");
		await publish(packageJson, newVersion, dry);
	} else {
		log("No new packages published, so no need to publish new registry.");
		// Just making sure...
		await validate();
	}

	await writeLog("publish-registry.md", logResult());
}

interface TypesRegistry {
	entries: { [key: string]: 1 };
}

async function generate(registry: TypesRegistry, packageJson: {}, log: Logger): Promise<void> {
	await clearOutputPath(registryOutputPath, log);
	await writeOutputFile("package.json", packageJson);
	await writeOutputFile("index.json", registry);
	await writeOutputFile("README.md", readme);

	function writeOutputFile(filename: string, content: {}): Promise<void> {
		return writeJson(joinPaths(registryOutputPath, filename), content);
	}
}

async function publish(packageJson: {}, version: string, dry: boolean): Promise<void> {
	const client = await NpmClient.create({ defaultTag: "next" });
	await client.publish(registryOutputPath, packageJson, dry);
	// Don't set it as "latest" until *after* it's been validated.
	await validate();
	await client.tag(packageName, version, "latest");
}

async function validate(): Promise<void> {
	console.log(validateOutputPath);
	await emptyDir(validateOutputPath);
	await writeJson(joinPaths(validateOutputPath, "package.json"), {
		name: "validate",
		version: "0.0.0",
		description: "description",
		readme: "",
		license: "",
		repository: {},
	});

	const npmPath = joinPaths(__dirname, "..", "node_modules", "npm", "bin", "npm-cli.js");
	const err = (await execAndThrowErrors(`node ${npmPath} install types-registry ${npmInstallFlags}`, validateOutputPath)).trim();
	if (err) {
		console.error(err);
	}

	await assertDirectoriesEqual(registryOutputPath, joinPaths(validateOutputPath, "node_modules", "types-registry"), {
		ignore: f => f === "package.json"
	});
}

function generatePackageJson(version: string, typesPublisherContentHash: string): {} {
	return {
		name: packageName,
		version,
		description: "A registry of TypeScript declaration file packages published within the @types scope.",
		repository: {
			type: "git",
			url: "https://github.com/Microsoft/types-publisher.git"
		},
		keywords: [
			"TypeScript",
			"declaration",
			"files",
			"types",
			"packages"
		],
		author: "Microsoft Corp.",
		license: "MIT",
		typesPublisherContentHash,
	};
}

function generateRegistry(typings: ReadonlyArray<TypingsData>): TypesRegistry {
	const entries: { [packageName: string]: 1 } = {};
	for (const { name } of typings) {
		entries[name] = 1;
	}
	return { entries };
}
