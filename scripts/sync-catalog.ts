// Runs from `npm version` (the `version` lifecycle script): after package.json
// is bumped and before the release commit, point the marketplace catalog at the
// release tag `npm version` is about to create, so marketplace installs track npm.

const catalogPath = new URL("../.omp-plugin/marketplace.json", import.meta.url);
const { version } = await Bun.file(new URL("../package.json", import.meta.url)).json();
const catalog = await Bun.file(catalogPath).json();

catalog.metadata.version = version;
for (const plugin of catalog.plugins) {
	plugin.version = version;
	plugin.source = { source: "github", repo: plugin.source.repo, ref: `v${version}` };
}

await Bun.write(catalogPath, `${JSON.stringify(catalog, null, "\t")}\n`);
