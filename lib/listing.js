// Folding `xcodebuild -list -json` answers into one listing.
//
// Kept apart from the host module, like `./parse-destinations.js`, so the shapes
// real xcodebuild produces can be tested without mounting a plugin.

/**
 * Fold one or two `-list -json` answers into a single listing.
 *
 * A workspace answers with `{ workspace: { name, schemes } }` and NOTHING else;
 * a project answers with `{ project: { name, schemes, configurations, targets } }`.
 * `inner` is the project a workspace wraps, consulted only because the workspace
 * itself never reports configurations.
 * @param {object} parsed - the answer for the project the caller named.
 * @param {object} [inner] - the answer for the project inside a workspace.
 * @returns {{name: string, schemes: string[], configurations: string[], targets: string[]}} listing.
 */
export function mergeListings(parsed, inner) {
  const workspace = parsed?.workspace ?? {}
  const project = parsed?.project ?? {}
  const nested = inner?.project ?? inner?.workspace ?? {}
  return {
    name: workspace.name ?? project.name ?? nested.name ?? '',
    schemes: workspace.schemes ?? project.schemes ?? nested.schemes ?? [],
    configurations: project.configurations ?? workspace.configurations ?? nested.configurations ?? [],
    targets: project.targets ?? workspace.targets ?? nested.targets ?? [],
  }
}
